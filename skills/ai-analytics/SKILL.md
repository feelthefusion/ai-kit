---
name: ai-analytics
description: "Use when tracking or analyzing AI on the site: every model call (task, model, provider, tokens, exact cost, latency, errors, fallbacks), conversation outcomes (resolved by AI, handed off, action done, abandoned), intents, CSAT / thumbs, confirm-card acceptance, AI-attributed orders and revenue, cost per resolution, bot performance per channel (web, email, SMS), automation runs, guard stops, spend anomalies — the admin AI dashboard, live cost meter, and `ai-report`. The only writer of AI numbers; site-wide event tracking hands off to Marketing Kit journey-analytics."
---

# AI Analytics (the only writer of AI numbers)

Files: `references/telemetry.ts` (writers) · `references/analytics.sql` (every dashboard query,
`-- name:` blocks shared by the admin console and `ai-report`).

## What it records (ai-schema.ts owners)
| table | written by | when |
|---|---|---|
| `ai_calls` | `recordTurn(db, forward)` (site-agent `onTurnEnd`) | every agent turn / model call: task, ref, servedBy, variant, tokens, `cost_micros`, latency, steps, tool calls, error |
| `ai_conversations` (outcome, intent, CSAT, attributed order) | `setOutcome`, `attributeOrder`, ml-lab labels | resolution, handoff, first order within the window |
| `ai_feedback` | `recordFeedback` | 👍/👎 + comment from the widget, SMS "1–5" replies |
| (reads) `ai_actions`, `ai_automation_runs` | site-agent / ai-automations | acceptance + automation stats |

Cost: OpenRouter's reported charge (`providerMetadata.openrouter.usage.cost`) when present — exact;
else ai_models pricing × tokens (refreshed by ai-evolve). Stored in **micro-dollars** (integer).

## Tracking hand-off (never two trackers)
- Marketing Kit installed → pass its collector as `forward`: every AI turn/outcome lands in crm_events as `ai.chat.turn`, `ai.conversation.resolved`, `ai.action.executed`, … with the same visitor/customer ids. Funnels, cohorts, campaign lift stay in `journey-analytics`.
- No Marketing Kit → ai_* tables are the AI record; site-wide tracking uses the app's own collector (helix has one).
- Reconcile spend against OpenRouter: `openrouter-generations` (per call) / `openrouter-analytics` (account).

## Dashboard (analytics.sql)
spend_by_task_model · spend_daily · conversations_by_channel (volume, resolution %, handoff %, turns, CSAT) · top_intents · actions (executed / proposed → acceptance %) · ai_revenue (orders credited within 24h of an AI conversation) · cost_per_resolution · automations · guard (stops before the model) · anomalies (hour > 3× trailing mean → ml-lab alert).
- Admin console: run the named queries; live tiles subscribe to SSE `/api/v1/admin/ai/live` (`ai.call`, `ai.conversation`, `ai.action`, `ai.automation`, `visitor`).
- Terminal: `ai-report` (all, last 7d) · `ai-report --days 30 spend_by_task_model ai_revenue` · `ai-report --sql cost_per_resolution`.

## Rules
- Every number cites its query (name from analytics.sql). Add a metric = add a named block, not ad-hoc SQL in a component.
- Model names are fine here (internal) — never in anything a customer can see.
- Outcomes feed ai-evolve (`scoreVariants`: resolved or action_done = win) — keep outcome labels honest; don't mark handoffs as resolved.

## Works with →
`site-agent` (onTurnEnd, hooks) · `ai-channels` (channel stats) · `ai-evolve` (scores variants from these tables) · `ml-lab` (labels, anomalies) · `live-bus` (live tiles) · Marketing Kit `journey-analytics` (crm_events) · `openrouter-generations` / `openrouter-analytics`.
