/**
 * visitor-intel · server — who is this device, what are they doing right now, and what should the AI know.
 *
 * TRUST RULE: an OSS visitor id is client-claimed. Use it for continuity + personalization (resume the
 * chat, remember the cart, score intent) — never as authentication. Account tools need a real session
 * (site-agent's actor), so a spoofed id can't touch anyone's account. A Pro id verified through the
 * Server API (`verifyPro`) is server-trusted and also carries bot/incognito/VPN/tampering signals.
 *
 * Identity graph (ai_visitor_identities): device ↔ customer / email / phone, stitched at every moment a
 * device proves who it is — login, checkout, chat sign-in, email click (?e=token), SMS click, form.
 * Cross-device: devicesFor(customerId) → the chat on the laptop continues on the phone.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { aiConversations, aiVisitorIdentities } from "../../ai-kit/references/ai-schema";
import { publish } from "../../live-bus/references/bus";

type Db = NodePgDatabase<Record<string, never>>;
export type IdentityKind = "customer" | "email" | "phone" | "contact" | "partner_code";
export type IdentitySource = "login" | "checkout" | "chat" | "email_click" | "sms_click" | "form";

export interface ProSignals { bot: "bad" | "good" | "not_detected"; incognito?: boolean; vpn?: boolean; tampering?: boolean; suspectScore?: number; confidence?: number }
export interface ResolvedVisitor { visitorId?: string; trusted: boolean; signals?: ProSignals }

const proCache = new Map<string, { at: number; v: ResolvedVisitor }>();

/** Fingerprint Pro: verify the client's event_id server-side (FP_SECRET_API_KEY). Cached 10 min. */
export async function verifyPro(eventId: string, claimedVisitorId: string | undefined, secretKey: string, region?: "us" | "eu" | "ap"): Promise<ResolvedVisitor> {
  const hit = proCache.get(eventId);
  if (hit && Date.now() - hit.at < 600_000) return hit.v;
  const { FingerprintServerApiClient, Region } = await import("@fingerprint/node-sdk");
  const client = new FingerprintServerApiClient({ apiKey: secretKey, ...(region ? { region: ({ us: Region.Global, eu: Region.EU, ap: Region.AP } as const)[region] } : {}) });
  const e = await client.getEvent(eventId);
  const vid = e.identification?.visitor_id;
  const v: ResolvedVisitor = {
    visitorId: vid, trusted: !!vid && (!claimedVisitorId || vid === claimedVisitorId),
    signals: { bot: e.bot ?? "not_detected", incognito: e.incognito, vpn: e.vpn, tampering: e.tampering, suspectScore: e.suspect_score, confidence: e.identification?.confidence?.score },
  };
  proCache.set(eventId, { at: Date.now(), v });
  return v;
}

/** Read the visitor from request headers (x-visitor-id, x-fp-event). */
export async function resolveVisitor(headers: Record<string, string | string[] | undefined>, env = process.env): Promise<ResolvedVisitor> {
  const claimed = String(headers["x-visitor-id"] ?? "").slice(0, 64) || undefined;
  const ev = String(headers["x-fp-event"] ?? "") || undefined;
  if (ev && env.FP_SECRET_API_KEY) { try { return await verifyPro(ev, claimed, env.FP_SECRET_API_KEY, env.FP_REGION as "us" | "eu" | "ap" | undefined); } catch { /* fall through */ } }
  return { visitorId: claimed, trusted: false };
}

/** Stitch: this device just proved an identifier. Idempotent; bumps last_seen. */
export async function link(db: Db, visitorId: string, kind: IdentityKind, value: string, source: IdentitySource, confidenceBp = 10_000) {
  if (!visitorId || !value) return;
  const v = kind === "email" ? value.trim().toLowerCase() : value.trim();
  await db.insert(aiVisitorIdentities).values({ visitorId, kind, value: v, source, confidenceBp })
    .onConflictDoUpdate({ target: [aiVisitorIdentities.visitorId, aiVisitorIdentities.kind, aiVisitorIdentities.value], set: { lastSeenAt: sql`now()`, confidenceBp: sql`greatest(${aiVisitorIdentities.confidenceBp}, ${confidenceBp})` } });
  publish("visitor", { visitorId, identified: kind, source });
}

/** Best customer id for a device (highest confidence, most recent). */
export async function whoIs(db: Db, visitorId: string): Promise<string | undefined> {
  const [r] = await db.select({ value: aiVisitorIdentities.value }).from(aiVisitorIdentities)
    .where(and(eq(aiVisitorIdentities.visitorId, visitorId), eq(aiVisitorIdentities.kind, "customer")))
    .orderBy(desc(aiVisitorIdentities.confidenceBp), desc(aiVisitorIdentities.lastSeenAt)).limit(1);
  return r?.value;
}

/** Every device a customer has used (cross-device chat continuity, "you left this in your cart"). */
export async function devicesFor(db: Db, customerId: string): Promise<string[]> {
  const rows = await db.select({ v: aiVisitorIdentities.visitorId }).from(aiVisitorIdentities)
    .where(and(eq(aiVisitorIdentities.kind, "customer"), eq(aiVisitorIdentities.value, customerId)));
  return rows.map((r) => r.v);
}

/** Open conversation to resume for this person, on any of their devices. */
export async function resumableConversation(db: Db, opts: { visitorId?: string; customerId?: string }): Promise<string | undefined> {
  const devices = opts.customerId ? await devicesFor(db, opts.customerId) : [];
  const ids = [...new Set([...(opts.visitorId ? [opts.visitorId] : []), ...devices])];
  if (!ids.length && !opts.customerId) return undefined;
  const [r] = await db.select({ id: aiConversations.id }).from(aiConversations)
    .where(and(eq(aiConversations.status, "open"), eq(aiConversations.channel, "web"), sql`(${opts.customerId ? sql`${aiConversations.customerId} = ${opts.customerId} or ` : sql``}${ids.length ? inArray(aiConversations.visitorId, ids) : sql`false`})`, sql`${aiConversations.lastAt} > now() - interval '7 days'`))
    .orderBy(desc(aiConversations.lastAt)).limit(1);
  return r?.id;
}

// ── live intent ──────────────────────────────────────────────────────────────────────────────
export interface SessionSignals { pagesThisSession: number; productViews: string[]; cartCents: number; checkoutStarted: boolean; returning: boolean; minutesOnSite: number; identified: boolean; pro?: ProSignals }

/** Rule-based until ml-lab trains intent_v1 on real outcomes; same 0..100 scale either way. */
export function intentScore(s: SessionSignals): { score: number; band: "hot" | "warm" | "cold" | "bot" } {
  if (s.pro?.bot === "bad") return { score: 0, band: "bot" };
  let x = Math.min(s.pagesThisSession, 10) * 3 + Math.min(s.productViews.length, 6) * 5 + (s.cartCents > 0 ? 20 : 0) + (s.checkoutStarted ? 25 : 0) + (s.returning ? 8 : 0) + (s.identified ? 7 : 0) + Math.min(s.minutesOnSite, 15);
  x = Math.min(100, x);
  return { score: x, band: x >= 60 ? "hot" : x >= 30 ? "warm" : "cold" };
}

/** Plain-text block for the agent's instructions. No raw ids, no staff-only fields. */
export function describeVisitor(s: SessionSignals & { lastProducts?: string[]; openConversationSummary?: string }): string {
  const { band } = intentScore(s);
  return [
    `${s.returning ? "Returning" : "New"} visitor, ${s.identified ? "identified" : "anonymous"}, ${s.minutesOnSite} min on site, ${s.pagesThisSession} pages, intent ${band}.`,
    s.productViews.length ? `Viewed: ${s.productViews.slice(-6).join(", ")}.` : "",
    s.cartCents > 0 ? `Cart: $${(s.cartCents / 100).toFixed(2)}${s.checkoutStarted ? " (checkout started)" : ""}.` : "",
    s.openConversationSummary ? `Earlier conversation: ${s.openConversationSummary}` : "",
  ].filter(Boolean).join(" ");
}
