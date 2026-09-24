/**
 * live-bus · sse — one SSE writer for every live surface (admin live visitors, live AI inbox,
 * live cost meter, automation runs, customer "your change is done" toasts).
 *
 * Headers that make SSE survive proxies (Railway, Cloudflare, nginx) — from helix visitors-routes:
 *   Content-Type text/event-stream, Cache-Control no-cache, no-transform, X-Accel-Buffering no,
 *   and compression MUST skip it. Filter on the RESPONSE content type, not the request Accept:
 *   AI SDK chat POSTs send Accept: *\/*, so an Accept-based filter gzips (= freezes) the chat stream.
 *
 *   app.use(compression({ filter: (req, res) =>
 *     String(res.getHeader("Content-Type") ?? "").startsWith("text/event-stream") ||
 *     req.headers.accept === "text/event-stream" ? false : compression.filter(req, res) }));
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { replay, subscribe, type Envelope, type Topic } from "./bus";

export interface SseOptions {
  topics: Topic[];
  /** Drop events this viewer must not see (e.g. customer toasts: only their own conversation). */
  filter?: (e: Envelope) => boolean;
  /** Reshape before send (strip staff-only fields for customer streams). */
  project?: (e: Envelope) => unknown;
  /** First frame (current snapshot) so the UI renders before any event. */
  snapshot?: () => Promise<unknown>;
  heartbeatMs?: number;
}

export function openSse(req: IncomingMessage, res: ServerResponse, o: SseOptions): () => void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");
  const send = (e: Envelope) => {
    if (o.filter && !o.filter(e)) return;
    res.write(`id: ${e.id}\nevent: ${e.topic}\ndata: ${JSON.stringify(o.project ? o.project(e) : e.data)}\n\n`);
  };

  const lastId = Number(req.headers["last-event-id"] ?? 0);
  if (lastId > 0) for (const e of replay(o.topics, lastId)) send(e);
  else if (o.snapshot) o.snapshot().then((s) => res.write(`event: snapshot\ndata: ${JSON.stringify(s)}\n\n`)).catch(() => {});

  const off = subscribe(o.topics, send);
  const beat = setInterval(() => res.write(": ping\n\n"), o.heartbeatMs ?? 25_000);
  const close = () => { clearInterval(beat); off(); };
  req.on("close", close);
  return close;
}
