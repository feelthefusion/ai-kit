/**
 * visitor-intel · client — one visitor id for the whole site (chat, tracking, cart, live presence).
 *
 *   AI_FINGERPRINT=oss (default)  @fingerprintjs/fingerprintjs — computed in the browser, no key, no network.
 *                                 This is exactly helix's client/src/lib/fingerprint.ts; keep that file and
 *                                 import getVisitorId from it — don't add a second fingerprinter.
 *   AI_FINGERPRINT=pro            @fingerprint/agent (Fingerprint Pro v4) — server-verifiable event_id,
 *                                 cross-browser-stable id, bot / incognito / VPN / tampering signals.
 *                                 Needs VITE_FP_PUBLIC_KEY (+ FP_SECRET_API_KEY on the server).
 *
 * Every API call carries the id in headers so the server (chat, collector, automations) sees the same
 * device: `x-visitor-id` always, `x-fp-event` with Pro so the server can verify it.
 */
export interface Visitor { visitorId: string; eventId?: string; tier: "oss" | "pro" | "none" }

const CACHE = "ai.vid";
let pending: Promise<Visitor> | null = null;

export function getVisitor(opts: { proKey?: string; region?: "us" | "eu" | "ap"; endpoint?: string } = {}): Promise<Visitor> {
  if (typeof window === "undefined") return Promise.resolve({ visitorId: "", tier: "none" });
  if (pending) return pending;
  pending = (async (): Promise<Visitor> => {
    try { const c = sessionStorage.getItem(CACHE); if (c) return JSON.parse(c) as Visitor; } catch { /* storage blocked */ }
    let v: Visitor = { visitorId: "", tier: "none" };
    try {
      if (opts.proKey) {
        const { default: Fingerprint } = await import("@fingerprint/agent");
        const agent = await Fingerprint.start({ apiKey: opts.proKey, ...(opts.region ? { region: opts.region } : {}), ...(opts.endpoint ? { endpoints: opts.endpoint } : {}) } as never);
        const r = await agent.get();
        v = { visitorId: r.visitor_id ?? "", eventId: r.event_id, tier: "pro" };
      } else {
        const { default: FingerprintJS } = await import("@fingerprintjs/fingerprintjs");
        const fp = await FingerprintJS.load();
        v = { visitorId: (await fp.get()).visitorId, tier: "oss" };
      }
    } catch { /* blockers / private mode: stay anonymous, never throw */ }
    try { if (v.visitorId) sessionStorage.setItem(CACHE, JSON.stringify(v)); } catch { /* ignore */ }
    return v;
  })();
  return pending;
}

/** Headers for every fetch (chat transport, collector, account API). */
export async function visitorHeaders(): Promise<Record<string, string>> {
  const v = await getVisitor({ proKey: (import.meta as { env?: Record<string, string> }).env?.VITE_FP_PUBLIC_KEY });
  return { ...(v.visitorId ? { "x-visitor-id": v.visitorId } : {}), ...(v.eventId ? { "x-fp-event": v.eventId } : {}) };
}
