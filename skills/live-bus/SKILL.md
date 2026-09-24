---
name: live-bus
description: "Use when anything on the site should update live or talk to other systems in real time: Server-Sent Events (SSE) streams for the admin live console (visitors, AI conversations, actions, cost meter, automation runs) and customer toasts ('your address was updated'), outbound webhooks to other apps (n8n, Zapier, sister sites) with Standard Webhooks signatures + retries, inbound signed webhooks that trigger AI, multi-instance fan-out (Postgres LISTEN/NOTIFY), replay on reconnect (Last-Event-ID), and the compression pitfall that freezes streams. Generalizes an existing live-visitors bus (helix visitors/bus.ts)."
---

# Live Bus (one event spine for every live feature)

Files: `references/bus.ts` (typed in-process bus + ring buffer + optional pg NOTIFY) · `references/sse.ts`
(the ONE SSE writer) · `references/webhooks.ts` (Standard Webhooks in + out).

## Topics (typed in bus.ts — add yours there)
`visitor` (visitor-intel presence) · `ai.conversation` · `ai.action` · `ai.call` · `ai.automation` ·
`ai.settings` (router/variant invalidation) · `ai.models` (catalog news) · `event` (business events:
order.paid, subscription.renewed, email.received, cron.daily … — the automation + channel trigger).
`publish(topic, data)` → `subscribe([topics], fn)`; envelopes carry `id` + `at`; `replay(topics, lastId)` serves reconnects. Who may see what is decided per SSE connection (`filter` / `project`), not at publish time.

## SSE (`openSse(req, res, { topics, filter, project, snapshot })`)
- One writer: heartbeat, `retry: 3000`, `Last-Event-ID` replay from the ring buffer, `snapshot` first frame, `filter` (e.g. only this customer's conversation), `project` (strip staff-only fields), cleanup on close.
- Admin: `GET /api/v1/admin/ai/live` (llm-router admin.ts) — visitors + AI activity in one stream. Customer: `GET /api/v1/ai/chat/:id/live` (site-agent routes).
- **Compression**: gzip buffers SSE unless the filter checks the RESPONSE `Content-Type`: `filter: (req, res) => !String(res.getHeader("Content-Type") || "").startsWith("text/event-stream") && compression.filter(req, res)`. `ai-doctor` checks this. Also `X-Accel-Buffering: no` behind nginx-style proxies.
- Multi-instance (Railway replicas): `fanoutViaPostgres(pool)` → publishes also go through `NOTIFY ai_live_bus` so every instance's SSE clients see every event. Single instance: skip it.

## Webhooks
- Out: `deliverOutbound(() => endpoints)` — subscribers in `ai_webhook_endpoints` (topics filter, secret from `newSecret()`, `active`). Signs with Standard Webhooks headers (`webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64 HMAC-SHA256>`), retries 4× (5s/10s/20s/40s) — publish-driven, never polled. Turn a dead endpoint off with `active = false`.
- In: `verifyInbound(secret, headers, rawBody)` (5-minute tolerance, constant-time compare) → `publish("event", …)`. Use `express.raw()` on the hook route; parse after verifying.
- Marketing Kit already receives Resend/Telnyx webhooks → republish them as `event` here; don't add a second receiver.

## helix
`server/modules/visitors/bus.ts` already fans out `ConsoleVisitorRow`s to the admin console. Keep its API;
implement `publishVisitor(row)` as `publish("visitor", row)` and serve the console with
`openSse(req, res, { topics: ["visitor", "ai.conversation", "ai.action", "ai.call"] })` — the visitors page and the AI console then share one stream and one heartbeat.

## Works with →
every owner publishes here: `visitor-intel`, `site-agent`, `ai-analytics`, `ai-automations` (subscribes to `event`), `ai-channels` (inbound), `ai-evolve` (`ai.settings`, `ai.models`), `llm-router` (invalidate on `ai.settings`).
