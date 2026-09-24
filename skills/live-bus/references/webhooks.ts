/**
 * live-bus · webhooks — the site talks to the outside world in real time, both directions,
 * using the Standard Webhooks signature scheme (webhook-id / webhook-timestamp / webhook-signature
 * "v1,<base64 HMAC-SHA256 of id.timestamp.body>"), so n8n, Zapier, Make, another site, or an
 * external agent can subscribe or trigger with no custom code.
 *
 *   OUT  deliverOutbound(): every bus event on a subscribed topic → POST to each endpoint.
 *   IN   verifyInbound():   POST /api/v1/ai/hooks/:name → publish("event", …) → ai-automations.
 *
 * Provider webhooks (Resend inbound/delivery, Telnyx SMS) stay with marketing-kit's
 * lifecycle-engine when it's installed — ai-channels subscribes to what it emits. Only when
 * marketing-kit is absent does ai-channels mount its own provider receivers (see ai-channels).
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { subscribe, type Envelope, type Topic } from "./bus";

export interface Endpoint { id: string; url: string; secret: string; topics: (Topic | "*")[]; active: boolean }

export function sign(secret: string, id: string, ts: number, body: string): string {
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, secret.startsWith("whsec_") ? "base64" : "utf8");
  return `v1,${createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64")}`;
}

/** Verify an inbound Standard-Webhooks request. Rejects replays older than 5 minutes. */
export function verifyInbound(secret: string, headers: Record<string, string | string[] | undefined>, rawBody: string, toleranceSec = 300): boolean {
  const id = String(headers["webhook-id"] ?? ""); const ts = Number(headers["webhook-timestamp"] ?? 0);
  const given = String(headers["webhook-signature"] ?? "");
  if (!id || !ts || !given || Math.abs(Date.now() / 1000 - ts) > toleranceSec) return false;
  const want = Buffer.from(sign(secret, id, ts, rawBody));
  return given.split(" ").some((g) => { const b = Buffer.from(g); return b.length === want.length && timingSafeEqual(b, want); });
}

async function post(ep: Endpoint, e: Envelope, attempt = 0): Promise<void> {
  const id = `msg_${e.id}`; const ts = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ type: e.topic, timestamp: e.at, data: e.data });
  try {
    const r = await fetch(ep.url, { method: "POST", headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": sign(ep.secret, id, ts, body) }, body, signal: AbortSignal.timeout(10_000) });
    if (!r.ok && r.status >= 500) throw new Error(String(r.status));
  } catch {
    if (attempt < 4) setTimeout(() => void post(ep, e, attempt + 1), 2 ** attempt * 5_000); // 5s,10s,20s,40s
  }
}

/** Start forwarding. `endpoints()` is re-read per event so admin edits apply instantly. */
export function deliverOutbound(endpoints: () => Promise<Endpoint[]> | Endpoint[]): () => void {
  return subscribe(["*"], async (e) => {
    for (const ep of await endpoints()) if (ep.active && (ep.topics.includes("*") || ep.topics.includes(e.topic))) void post(ep, e);
  });
}

export const newSecret = () => `whsec_${Buffer.from(randomUUID() + randomUUID()).toString("base64").slice(0, 43)}`;
