/**
 * ai-channels — the email bot and the SMS bot. Same agent, guard, actions and analytics as web chat;
 * only transport differs. Inbound arrives on the bus, replies go out through ONE sender.
 *
 * Cohesion with marketing-kit:
 *   inbound   lifecycle-engine already receives Resend inbound + Telnyx webhooks → it publishes
 *             "email.received" / "sms.received" events; ai-channels subscribes. No second receiver.
 *   outbound  lifecycle-engine's outbox is THE sender (idempotency, suppression, send log). ai-channels
 *             calls `send()` = that outbox. Without marketing-kit, `send()` calls Resend/Telnyx directly.
 *
 * Identity: email From is spoofable → treat as the customer only when the inbound verdict says
 * DKIM/SPF pass. SMS From is carrier-delivered → customer when it matches a verified phone. Otherwise
 * the sender is a guest: public help only, account changes get a sign-in link.
 *
 * Triage (when a "decide" task exists — Jev, ~100 ms, near-free): before the agent runs, ONE typed
 * decision answers needs_reply / wants_human / urgency. Confidently-not-a-person mail (receipts,
 * newsletters, out-of-office that slipped past the header check) is dropped at P(needs_reply) < 0.15;
 * everything else is answered as usual and `onTriage` gets the signals (priority inbox, staff ping).
 *
 * Confirming actions off-web: pending approval → SMS "Reply YES to confirm: …" / email confirm link.
 * The signed approval request stays in the stored transcript; YES appends the approval response.
 */
import { convertToModelMessages, type ModelMessage, type UIMessage } from "ai";
import type { Actor, Channel } from "../../site-agent/references/actions";
import { runTurn, type AgentDeps } from "../../site-agent/references/agent";
import { decide, level, p as prob, yes } from "../../llm-router/references/decide";

export interface Inbound {
  channel: "email" | "sms" | "whatsapp";
  from: string; to: string; text: string;
  subject?: string; messageId?: string; inReplyTo?: string; references?: string[];
  /** Resend inbound auth verdict / carrier trust. */
  verified: boolean;
  autoSubmitted?: boolean;
}

export interface ChannelDeps extends AgentDeps {
  /** email → customer id (verified senders only), phone → customer id. */
  customerFor(channel: Inbound["channel"], address: string): Promise<string | undefined>;
  threads: {
    /** Stable thread key: email root Message-ID, or `sms:<from>:<to>`. Returns conversation id. */
    resolve(key: string, channel: Channel, address: string, customerId?: string): Promise<string>;
    load(conversationId: string): Promise<ModelMessage[]>;
    append(conversationId: string, messages: ModelMessage[]): Promise<void>;
    pending(conversationId: string): Promise<{ approvalId: string; summary: string } | undefined>;
    setPending(conversationId: string, p: { approvalId: string; summary: string } | undefined): Promise<void>;
    /** Bot replies in this thread during the last hour (mail-loop brake). */
    recentBotReplies(conversationId: string): Promise<number>;
    /** ai_conversations.status — "handoff" once staff replied / took over: the bot stays quiet. */
    status?(conversationId: string): Promise<string | undefined>;
  };
  /** marketing-kit lifecycle-engine outbox when installed; else direct provider send. */
  send(m: { channel: Inbound["channel"]; to: string; from: string; body: string; subject?: string; inReplyTo?: string; idempotencyKey: string }): Promise<void>;
  /** Triage signals for every inbound a person sent (0–1 probabilities; urgency 0 routine · 1 soon · 2 urgent). */
  onTriage?(conversationId: string, t: { needsReply: number; wantsHuman: number; urgency: number }): void | Promise<void>;
  /** Signed confirm link for email approvals (GET → appends approval, re-runs). */
  confirmUrl?(conversationId: string, approvalId: string): string;
}

const YES = /^\s*(y|yes|yeah|yep|confirm|ok|okay|do it|sure)\s*[.!]*\s*$/i;
const NO = /^\s*(n|no|nope|cancel|stop that|don'?t)\s*[.!]*\s*$/i;
const AUTO = /(^|\b)(no-?reply|mailer-daemon|postmaster|bounce)/i;

export const TRIAGE = {
  needs_reply: { type: "boolean", instructions: "Is this message from a person who expects a reply (not an automatic receipt, newsletter, out-of-office, notification or bounce)?" },
  wants_human: { type: "boolean", instructions: "Does the sender ask for, or clearly need, a human staff member rather than an automated assistant?" },
  urgency: { type: "score", instructions: "How time-sensitive is this message for the business?", criteria: ["routine", "soon — within a day", "urgent — needs attention now"] },
} as const;

export function threadKey(m: Inbound): string {
  if (m.channel === "email") return `email:${m.references?.[0] ?? m.inReplyTo ?? m.messageId ?? `${m.from}:${m.subject ?? ""}`}`;
  return `${m.channel}:${m.from}:${m.to}`;
}

export async function handleInbound(d: ChannelDeps, m: Inbound): Promise<{ replied: boolean; reason?: string }> {
  if (m.autoSubmitted || AUTO.test(m.from)) return { replied: false, reason: "auto-generated" };
  const customerId = m.verified ? await d.customerFor(m.channel, m.from) : undefined;
  const actor: Actor = customerId ? { kind: "customer", customerId } : { kind: "guest" };
  const convId = await d.threads.resolve(threadKey(m), m.channel, m.from, customerId);
  if ((await d.threads.status?.(convId)) === "handoff") return { replied: false, reason: "human handling" };
  if ((await d.threads.recentBotReplies(convId)) >= 8) return { replied: false, reason: "loop brake" };

  const history = await d.threads.load(convId);
  const pending = await d.threads.pending(convId);
  let incoming: ModelMessage[];
  if (pending && (YES.test(m.text) || NO.test(m.text))) {
    incoming = [{ role: "tool", content: [{ type: "tool-approval-response", approvalId: pending.approvalId, approved: YES.test(m.text) }] }];
    await d.threads.setPending(convId, undefined);
  } else {
    incoming = [{ role: "user", content: m.channel === "email" && m.subject && !history.length ? `Subject: ${m.subject}\n\n${stripQuoted(m.text)}` : stripQuoted(m.text) }];
  }

  const turnText = incoming[0].role === "user" ? String(incoming[0].content) : "";
  if (turnText && (await d.router.has("decide"))) {
    try {
      const t = await decide(d.router, {
        purpose: "triage", questions: TRIAGE, onCall: d.onDecision, context: { conversationId: convId, channel: m.channel },
        state: { channel: m.channel, subject: m.subject ?? null, message: turnText.slice(0, 4000) },
      });
      await d.onTriage?.(convId, { needsReply: prob(t, "needs_reply"), wantsHuman: prob(t, "wants_human"), urgency: level(t, "urgency") });
      if (!yes(t, "needs_reply", 0.15)) return { replied: false, reason: "not a person" };
    } catch { /* triage is best-effort — answer as usual */ }
  }
  const r = await runTurn(d, { actor, channel: m.channel, conversationId: convId, correlationId: `${convId}:${m.messageId ?? Date.now()}`, text: turnText }, [...history, ...incoming]);

  let body = r.text;
  const ask = r.pendingApprovals[0] as { approvalId: string; toolCall?: { toolName: string } } | undefined;
  if (ask) {
    const summary = body || `Confirm ${ask.toolCall?.toolName ?? "this change"}?`;
    await d.threads.setPending(convId, { approvalId: ask.approvalId, summary });
    body = m.channel === "email" && d.confirmUrl ? `${summary}\n\nConfirm: ${d.confirmUrl(convId, ask.approvalId)}\n\n(or reply YES)` : `${summary} Reply YES to confirm or NO to cancel.`;
  }
  await d.threads.append(convId, [...incoming, ...r.responseMessages]);
  if (!body.trim()) return { replied: false, reason: "empty" };
  await d.send({ channel: m.channel, to: m.from, from: m.to, body, subject: m.subject ? (m.subject.startsWith("Re:") ? m.subject : `Re: ${m.subject}`) : undefined, inReplyTo: m.messageId, idempotencyKey: `ai-reply:${convId}:${m.messageId ?? turnText.slice(0, 40)}` });
  return { replied: true };
}

/** Drop quoted history ("On … wrote:", "> …") so the bot answers only what's new. */
export function stripQuoted(t: string): string {
  const cut = t.search(/\n(On .{5,80} wrote:|-{2,} ?Original Message|From: .+\nSent: )/i);
  return (cut > 0 ? t.slice(0, cut) : t).split("\n").filter((l) => !l.startsWith(">")).join("\n").trim().slice(0, 6000);
}

/** Web transcripts (UIMessage) → model messages, for a customer who moves from chat to email. */
export async function fromWeb(ui: UIMessage[]) { return convertToModelMessages(ui); }
