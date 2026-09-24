/**
 * live-bus · bus — THE realtime backbone. One in-process bus every AI Kit owner publishes to and
 * every SSE stream / webhook / automation subscribes from. Generalizes helix's visitors/bus.ts
 * (keep `publishVisitor(row)` there as a one-line wrapper: publish("visitor", row)).
 *
 * • Typed topics — add yours to Topics; payloads are the SAME projection the REST endpoint returns,
 *   so a pushed row is byte-identical to a fetched one (the helix rule).
 * • Replay — each topic keeps a ring of the last N events with monotonically increasing ids, so an
 *   SSE client reconnecting with Last-Event-ID gets what it missed (no gaps on flaky mobile).
 * • Multi-instance — call `fanoutViaPostgres(pool)` once: publishes go through NOTIFY and every
 *   node re-emits locally. Postgres is already there (Railway); no Redis to run.
 */
import { EventEmitter } from "node:events";

export interface Topics {
  visitor: { visitorId: string; [k: string]: unknown };           // visitor-intel (helix ConsoleVisitorRow)
  "ai.conversation": { id: string; channel: string; status: string; visitorId?: string; customerId?: string; lastText?: string; intent?: string };
  "ai.action": { action: string; status: string; channel: string; conversationId?: string; summary?: string };
  "ai.call": { task: string; costMicros?: number; latencyMs?: number; channel?: string; error?: string };
  "ai.automation": { automationId: string; runId: string; status: string; eventId?: string };
  "ai.settings": { kind: "model" | "key" | "persona" | "automation"; task?: string };
  "ai.models": { added: string[]; retired: string[] };
  /** Business events that trigger automations (order.paid, subscription.renewed, …). */
  event: { name: string; id: string; subject?: string; data?: Record<string, unknown> };
}
export type Topic = keyof Topics;
export interface Envelope<T extends Topic = Topic> { id: number; topic: T; at: string; data: Topics[T] }

const RING = 200;
const emitter = new EventEmitter();
emitter.setMaxListeners(0);
const rings = new Map<Topic, Envelope[]>();
let seq = Date.now() * 1000; // monotonic across restarts; ids are opaque to clients
let remote: ((e: Envelope) => Promise<void>) | undefined;

function local(e: Envelope) {
  const r = rings.get(e.topic) ?? [];
  r.push(e);
  if (r.length > RING) r.shift();
  rings.set(e.topic, r);
  emitter.emit(e.topic, e);
  emitter.emit("*", e);
}

export function publish<T extends Topic>(topic: T, data: Topics[T]): Envelope<T> {
  const e: Envelope<T> = { id: ++seq, topic, at: new Date().toISOString(), data };
  if (remote) remote(e).catch(() => local(e)); else local(e);
  return e;
}

/** Subscribe to one or more topics (or "*"). Returns unsubscribe. */
export function subscribe(topics: (Topic | "*")[], fn: (e: Envelope) => void): () => void {
  for (const t of topics) emitter.on(t, fn);
  return () => { for (const t of topics) emitter.off(t, fn); };
}

/** Events after `lastId` for these topics, oldest first (SSE Last-Event-ID replay). */
export function replay(topics: Topic[], lastId: number): Envelope[] {
  return topics.flatMap((t) => rings.get(t) ?? []).filter((e) => e.id > lastId).sort((a, b) => a.id - b.id);
}

/** Minimal pg Pool shape (node-postgres). */
interface PgPool {
  connect(): Promise<{ query(sql: string): Promise<unknown>; on(ev: "notification", fn: (m: { channel: string; payload?: string }) => void): void; release(): void }>;
  query(sql: string, params: unknown[]): Promise<unknown>;
}

/** Multi-node fan-out through Postgres LISTEN/NOTIFY (payload cap 8000 bytes → big events carry a ref). */
export async function fanoutViaPostgres(pool: PgPool, channel = "ai_live_bus") {
  const client = await pool.connect();
  await client.query(`LISTEN ${channel}`);
  client.on("notification", (m) => {
    if (m.channel !== channel || !m.payload) return;
    try { local(JSON.parse(m.payload) as Envelope); } catch { /* ignore malformed */ }
  });
  remote = async (e) => {
    const body = JSON.stringify(e);
    await pool.query("SELECT pg_notify($1, $2)", [channel, body.length < 7900 ? body : JSON.stringify({ ...e, data: { truncated: true, ...pick(e.data) } })]);
  };
  return () => { remote = undefined; client.release(); };
}
const pick = (d: unknown) => (d && typeof d === "object" ? Object.fromEntries(Object.entries(d).filter(([, v]) => typeof v !== "object").slice(0, 12)) : {});

/** Test helper. */
export function __resetBus() { rings.clear(); emitter.removeAllListeners(); remote = undefined; }
