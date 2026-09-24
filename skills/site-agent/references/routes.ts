/**
 * site-agent · routes — Express wiring for the web chat bot (AI SDK UI stream protocol).
 *
 *   POST /api/v1/ai/chat                 one turn (client sends ONLY its newest message)
 *   GET  /api/v1/ai/chat/:id             history (for reload / cross-device via visitor-intel)
 *   GET  /api/v1/ai/chat/:id/live        SSE: "your address was updated", "a teammate joined"
 *   POST /api/v1/ai/chat/:id/feedback    thumbs / CSAT → ai-analytics
 *
 * History lives server-side (ai_messages). The client can't rewrite the transcript; an approval
 * response replaces the assistant message by id and is verified by its HMAC signature.
 */
import { randomUUID } from "node:crypto";
import type { Request, Response, Router } from "express";
import { createUIMessageStream, pipeAgentUIStreamToResponse, pipeUIMessageStreamToResponse, type UIMessage } from "ai";
import { openSse } from "../../live-bus/references/sse";
import { publish } from "../../live-bus/references/bus";
import type { Actor } from "./actions";
import { prepareTurn, runTurn, type AgentDeps } from "./agent";

export interface ConversationStore {
  /** Existing conversation this actor may continue, else a new one. */
  resolve(id: string | undefined, actor: Actor, channel: "web"): Promise<string>;
  owns(id: string, actor: Actor): Promise<boolean>;
  load(id: string): Promise<UIMessage[]>;
  save(id: string, messages: UIMessage[]): Promise<void>;
  feedback(id: string, messageId: string | undefined, rating: number, kind: "thumbs" | "csat", comment?: string): Promise<void>;
}

export interface ChatRouteDeps extends AgentDeps {
  store: ConversationStore;
  /** Session → actor. Signed-in customer, else guest keyed by the FingerprintJS visitor id header. */
  actorFor(req: Request): Promise<Actor>;
  /** Abuse brake per visitor (messages per 5 minutes). 0 = off. Default 60. */
  turnsPer5Min?: number;
}

export const lastUserText = (msgs: UIMessage[]) => {
  const m = [...msgs].reverse().find((x) => x.role === "user");
  return m ? m.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n") : "";
};

/** Replace by id (approval responses update the last assistant message) or append. */
export function upsert(history: UIMessage[], incoming: UIMessage): UIMessage[] {
  const i = history.findIndex((m) => m.id === incoming.id);
  if (i === -1) return [...history, incoming];
  if (history[i].role !== incoming.role) return history; // never let the client change who said what
  return [...history.slice(0, i), incoming, ...history.slice(i + 1)];
}

const buckets = new Map<string, number[]>();
function brake(key: string, limit: number): boolean {
  if (!limit) return false;
  const now = Date.now(); const w = (buckets.get(key) ?? []).filter((t) => now - t < 300_000);
  w.push(now); buckets.set(key, w);
  return w.length > limit;
}

export function mountChat(r: Router, d: ChatRouteDeps) {
  r.post("/chat", async (req: Request, res: Response) => {
    const actor = await d.actorFor(req);
    const who = actor.kind === "customer" ? actor.customerId : ("visitorId" in actor && actor.visitorId) || req.ip || "anon";
    if (brake(String(who), d.turnsPer5Min ?? 60)) return res.status(429).json({ error: "One moment, please try again shortly." });

    const { conversationId, message } = (req.body ?? {}) as { conversationId?: string; message?: UIMessage };
    if (!message || (message.role !== "user" && message.role !== "assistant") || !Array.isArray(message.parts)) return res.status(400).json({ error: "message required" });

    const id = await d.store.resolve(conversationId, actor, "web");
    const messages = upsert(await d.store.load(id), message);
    const text = message.role === "user" ? lastUserText([message]) : ""; // approvals skip the guard
    const correlationId = randomUUID();
    res.setHeader("x-conversation-id", id);
    publish("ai.conversation", { id, channel: "web", status: "open", visitorId: "visitorId" in actor ? actor.visitorId : undefined, customerId: actor.kind === "customer" ? actor.customerId : undefined, lastText: text.slice(0, 200) });

    const p = await prepareTurn(d, { actor, channel: "web", conversationId: id, correlationId, text });
    if (p.kind === "canned") {
      const stream = createUIMessageStream({
        originalMessages: messages,
        execute: ({ writer }) => {
          const tid = randomUUID();
          writer.write({ type: "text-start", id: tid });
          writer.write({ type: "text-delta", id: tid, delta: p.text });
          writer.write({ type: "text-end", id: tid });
        },
        onEnd: ({ messages: all }) => d.store.save(id, all),
      });
      return pipeUIMessageStreamToResponse({ response: res, stream });
    }

    await pipeAgentUIStreamToResponse({
      response: res,
      agent: p.agent,
      uiMessages: messages,
      originalMessages: messages as never,
      sendReasoning: false,          // reasoning can name the model; never stream it to customers
      sendSources: true,
      onEnd: ({ messages: all }) => d.store.save(id, all),
      onError: () => "Sorry, something went wrong on our side. Please try again.", // never leak provider errors
    });
  });

  r.get("/chat/:id", async (req, res) => {
    const actor = await d.actorFor(req);
    if (!(await d.store.owns(req.params.id, actor))) return res.status(404).end();
    res.json({ id: req.params.id, messages: await d.store.load(req.params.id) });
  });

  r.get("/chat/:id/live", async (req, res) => {
    const actor = await d.actorFor(req);
    if (!(await d.store.owns(req.params.id, actor))) return res.status(404).end();
    openSse(req, res, {
      topics: ["ai.action", "ai.conversation"],
      filter: (e) => (e.data as { conversationId?: string; id?: string }).conversationId === req.params.id || (e.topic === "ai.conversation" && (e.data as { id: string }).id === req.params.id),
      project: (e) => (e.topic === "ai.action" ? { action: (e.data as { action: string }).action, status: (e.data as { status: string }).status, summary: (e.data as { summary?: string }).summary } : { status: (e.data as { status: string }).status }),
    });
  });

  r.post("/chat/:id/feedback", async (req, res) => {
    const actor = await d.actorFor(req);
    if (!(await d.store.owns(req.params.id, actor))) return res.status(404).end();
    const { messageId, rating, kind = "thumbs", comment } = req.body ?? {};
    if (typeof rating !== "number") return res.status(400).end();
    await d.store.feedback(req.params.id, messageId, rating, kind, typeof comment === "string" ? comment.slice(0, 1000) : undefined);
    res.status(204).end();
  });
}

/**
 * POST /api/v1/ai/eval  { text, history? } → { text, verdict }   (Authorization: Bearer AI_EVAL_TOKEN)
 * Plain-JSON target for promptfoo evals + red team (`ai-eval promptfoo|redteam`). Runs as a GUEST on
 * the web channel through the full guard/persona/scrub pipeline — account tools are unreachable, so a
 * red team can hammer it without touching real customer data. Disabled unless AI_EVAL_TOKEN is set.
 */
export function mountEval(r: Router, d: AgentDeps) {
  r.post("/eval", async (req: Request, res: Response) => {
    const token = process.env.AI_EVAL_TOKEN;
    if (!token || String(req.headers.authorization ?? "") !== `Bearer ${token}`) return res.status(404).end();
    const text = String(req.body?.text ?? "");
    const history = Array.isArray(req.body?.history) ? req.body.history : [];
    const out = await runTurn(d, { actor: { kind: "guest", visitorId: "eval" }, channel: "web", correlationId: randomUUID(), text },
      [...history, { role: "user", content: text }]);
    res.json({ text: out.text, verdict: out.verdict, proposed: out.pendingApprovals.length });
  });
}
