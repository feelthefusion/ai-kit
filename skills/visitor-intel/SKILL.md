---
name: visitor-intel
description: "Use when identifying website visitors or customers, device fingerprinting with FingerprintJS (open-source by default, Fingerprint Pro optional with bot/incognito/VPN/tampering signals), stitching anonymous devices to customers/emails/phones across devices, live visitor presence, session signals and intent scoring (hot/warm/cold/bot), giving the AI bots context about who they are talking to, and resuming a chat across reloads or devices. Extends an app's existing live-visitors module (e.g. helix visitors/bus.ts) instead of replacing it."
---

# Visitor Intel (who is this, what are they doing, what should the AI know)

Files: `references/fingerprint.ts` (browser) · `references/identity.ts` (server).

## Tiers (`ai-settings fingerprint oss|pro`)
| tier | package | trust | extra |
|---|---|---|---|
| `oss` (default) | `@fingerprintjs/fingerprintjs` (browser, no key) | **client-claimed** | — |
| `pro` | `@fingerprint/agent` (browser, VITE_FP_PUBLIC_KEY) + `@fingerprint/node-sdk` (server, FP_SECRET_API_KEY) | server-verified via `getEvent(event_id)` | bot, incognito, VPN, tampering, suspect score |

**Trust rule:** an OSS id is for continuity + personalization only (resume chat, cart, context, intent).
Never auth: account actions need a session (site-agent's actor). Pro ids verified by `verifyPro`
are trusted and bots (`bot: "bad"`) get intent band `bot` (skip AI spend, skip live alerts).

## Wiring
- Browser: `visitorHeaders()` on every AI/tracking request (`x-visitor-id`, `x-fp-event` for Pro). If the app already computes a visitor id (helix `client/src/lib/fingerprint.ts`), reuse it — one id site-wide.
- Server: `resolveVisitor(req.headers)` → `{ visitorId, trusted, signals }` → site-agent actor + context.
- Stitch at every proof moment: login, checkout, chat sign-in, email click (`?e=token`), SMS click, form → `link(db, visitorId, kind, value, source)` (ai_visitor_identities). `whoIs` / `devicesFor` → cross-device continuity; `resumableConversation` picks the chat back up.
- Presence: publish `visitor` on live-bus. In helix, `visitors/bus.ts` `publishVisitor(row)` becomes `publish("visitor", row)` — the admin live-visitors page and the AI console read the same stream.
- Context for the agent: `describeVisitor(signals)` — returning?, pages, products viewed, cart value, identified? No raw ids or PII beyond what the customer already gave.
- Intent: `intentScore(signals)` rule-based until ml-lab trains `intent_v1` (logistic regression on real conversions), then the learned model replaces it.

## Works with →
`site-agent` (actor + context) · `live-bus` (presence) · `ml-lab` (intent model, recs) · `ai-analytics` (visitor-level funnels, AI-attributed orders) · Marketing Kit `journey-analytics` (same visitor id on crm_events).
