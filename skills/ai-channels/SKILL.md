---
name: ai-channels
description: "Use when building the email bot or SMS / WhatsApp bot — AI that reads inbound customer email or texts and replies (order status, subscription changes, address updates, product questions) with the same agent, guard, actions and analytics as web chat: thread resolution, verified-sender identity (DKIM/SPF verdict for email, carrier number for SMS), 'Reply YES to confirm' / signed confirm links for write actions, quoted-text stripping, auto-reply and mail-loop protection, handoff to a human. Sending goes through Marketing Kit lifecycle-engine when installed."
---

# AI Channels (email bot + SMS bot — same brain, different transport)

File: `references/channels.ts` → `handleInbound(deps, message)`.

## Flow
1. **Inbound** arrives on live-bus `event` (`email.received` / `sms.received`) — from Marketing Kit's inbound webhooks when installed (Resend inbound, Telnyx messaging), else the app's own receivers (`agent-email-inbox`, `telnyx-messaging-javascript`).
2. **Filter**: auto-replies / bounces (`no-reply`, `mailer-daemon`, `Auto-Submitted`) ignored; > N bot replies/hour in one thread → stop (mail-loop brake).
3. **Identity**: `customerFor(channel, address)` only when `verified` (email DKIM/SPF pass; SMS carrier-delivered number). Unverified → guest actor: public help + "sign in to change your account".
4. **Thread**: `threadKey` = email root Message-ID (References/In-Reply-To) or `sms:<from>:<to>` → one ai_conversations row; history loaded, quoted text stripped.
5. **Turn**: `runTurn` (site-agent) with channel `email`/`sms` → task `channel_reply`, persona + scrub on.
6. **Approvals off-web**: a write → the signed approval request is stored with the thread; reply asks *"Reply YES to confirm: <summary>"* (SMS) or links `confirmUrl` (email). YES/NO → approval response appended → re-run → action executes for the verified customer only.
7. **Send**: `send({ channel, to, from, body, subject, inReplyTo, idempotencyKey })` → lifecycle-engine outbox (one sender) or direct Resend/Telnyx.

## Rules
- Plain text for SMS (short, one question at a time); email keeps the thread (`In-Reply-To`) and signs off as the persona.
- A human reply in the thread (staff) or `handoff_to_human` sets ai_conversations `status = handoff` → `threads.status()` makes the bot stay quiet in that thread (publish `ai.conversation` so the inbox shows it).
- Telnyx-hosted voice/SMS assistants (`telnyx-ai-assistants-javascript`) can call the site through the same actions via MCP — never a second logic path.

## Works with →
`site-agent` (runTurn, actions, guard) · `ai-analytics` (per-channel stats) · `live-bus` (inbound events, handoff) · Marketing Kit `lifecycle-engine` (sender + inbound webhooks) · `agent-email-inbox` · `telnyx-ai-assistants-javascript`.
