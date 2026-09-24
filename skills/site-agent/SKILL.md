---
name: site-agent
description: "Use when building or changing the site's AI chat bot / help bot / support assistant, the admin/staff copilot, or anything that lets AI act on the site — updating subscriptions, addresses, profiles, orders, carts, customer records from chat — safely: action registry (zod inputs, permissions, customer id from the session), HMAC-signed confirm cards for writes, audit + live events, the identity lock (never reveal the model/vendor — 'a custom-built assistant developed for the site') and the site-only scope lock, the web widget (useChat), server-side conversation persistence, the eval endpoint, and the site-ops MCP server."
---

# Site Agent (the ONE agent behind every AI surface)

Files (`references/`): `actions.ts` registry + starter actions · `guard.ts` identity/scope lock ·
`agent.ts` prepareTurn/runTurn · `routes.ts` Express chat + eval · `chat-widget.tsx` React ·
`mcp.ts` MCP server. All typecheck + pass e2e against the latest AI SDK (kit `tests/e2e`).

## How a turn runs (`prepareTurn`)
1. **preflight** (customer-facing only): identity probe / prompt injection / off-topic → canned reply, **zero model calls**. Stage 2 for subtle cases (`guardModel: true`): with a `decide` task, `classifyTyped` — ONE typed decision (Jev, ≈0.1–0.7 s, ≈free) that blocks only at confidence ≥ AI_GUARD_MIN (0.6), so an unsure call never stops a real customer; without it, `classifyTurn` on the `guard` text model.
2. **context**: persona instructions + visitor-intel context + customer summary + ai-knowledge hits.
3. **model**: `llm-router.model(task)` wrapped in `identityScrub` (stream-safe vendor-name rewrite; drops reasoning).
4. **ToolLoopAgent** with `buildTools(actions, ctx)`: only actions the actor + channel may use; writes pause for a **signed approval** (`experimental_toolApprovalSecret` = AI_APPROVAL_SECRET — a tampered or forged approval fails closed).
5. `onTurnEnd` → ai-analytics; `onDecision` → ai-analytics `recordDecision` (guard, and every channel / knowledge / automation decision that receives AgentDeps); `hooks.record/publish` → ai_actions + live-bus.

## Actions = the only way AI changes data
```ts
defineAction({
  name: "update_shipping_address", scope: "customer", mode: "write", channels: ["web", "sms", "email"],
  description: "Change the customer's default shipping address (future orders + active subscriptions).",
  input: z.object({ address: AddressInput, applyToSubscriptions: z.boolean().default(true) }),
  summarize: (i) => `Ship to ${i.address.line1}, ${i.address.city}`,          // the Confirm card text
  run: (i, ctx) => services.updateShippingAddress(ctx.customerId!, i.address, i.applyToSubscriptions),
});
```
- `scope`: guest | customer | staff. `ctx.customerId` comes from the SESSION (closure) — never an input field. Staff actions take ids and need `permission` (the app's RBAC string, e.g. "customers:write").
- `run` calls the app's existing service functions (same code the account page uses → one source of truth, `consistency` skill).
- `confirm` (default: customer/guest writes confirm, reads don't): `true` / `false` / `(input, ctx) => boolean` — e.g. confirm refunds over $50 even for staff.
- New capability = new action. Never hand the model raw SQL, fetch, or file access.

## Identity + scope lock (customer-facing)
- Persona from `.agents/ai-stack.md`: assistant name, site name, topics. Any "what AI / model / company are you" → *"I'm <name>, a custom-built assistant developed specifically for <site>."*
- Scrub allow-list for product names that look like vendors (e.g. a product called "Gemini").
- UI stream: `sendReasoning: false`; no model id in `messageMetadata`, headers (only `x-conversation-id`) or errors (`onError` returns a generic message).
- Staff copilot (`actor.kind === "staff"`) is NOT persona-locked and sees staff tools.

## Web chat (routes.ts + chat-widget.tsx)
- Client sends ONLY its newest message + conversationId; server loads history (client can't rewrite it; `upsert` keeps roles).
- Guests: bind conversations to an httpOnly cookie, not the (client-claimed) visitor id. Customers: owner check.
- `GET /chat/:id/live` (SSE) → "Address updated ✓", "A teammate joined".
- `POST /eval` (bearer AI_EVAL_TOKEN, guest actor) → promptfoo target for `ai-eval promptfoo|redteam`.
- Compression: filter on the RESPONSE content-type (`text/event-stream`) or the stream buffers — `ai-doctor` checks.

## MCP (mcp.ts)
Same registry → MCP tools (`registerTool`, zod shapes). HTTP `/api/v1/ai/mcp` (bearer AI_MCP_TOKENS → staff actor) or stdio (`"ai:mcp"` script → `ai-mcp site`, registered per repo by ai-init).

## Tests to keep green (`ai:test`, run by verify.sh)
Port the kit's `tests/e2e/site-agent.test.ts` cases with the app's actions: identity probes short-circuit; scrub on split streams; customers never see staff tools; writes wait for approval and run with the session customer; tampered approval never executes.

## Works with →
`llm-router` (models) · `ai-knowledge` (facts) · `visitor-intel` (who + context) · `ai-channels` (same agent on email/SMS) · `ai-automations` (actor = automation) · `ai-analytics` (every turn) · `live-bus` (events) · `ai-evolve` (eval gate uses prepareTurn) · `use-ai-sdk` / `ai-elements` (API + UI truth).
