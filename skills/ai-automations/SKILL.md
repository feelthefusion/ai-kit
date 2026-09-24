---
name: ai-automations
description: "Use when adding AI that works in the background on events — order paid, subscription renewed, payment failed, review posted, ticket opened, nightly/hourly schedules — and decides + acts with a narrow set of site-agent actions: data hygiene (fix malformed addresses/phones), VIP tagging, enrichment, triage, routing, follow-ups, syncing admin or customer data. Declarative specs (trigger, filter, allowed actions, instructions), dry_run by default, idempotent per event, recorded and streamed live."
---

# AI Automations (event → narrow agent → recorded, live)

File: `references/automations.ts`. Specs live in the repo (`automations/*.automation.json`) or ai_automations (admin-editable).

## Spec
```json
{ "id": "vip-tag", "trigger": "order.*", "when": { "tier": "gold" }, "mode": "dry_run",
  "permissions": ["customers:write"], "actions": ["find_customer", "staff_update_customer"],
  "instructions": "If this customer's lifetime spend passed $1,000, add the VIP tag. Otherwise do nothing.",
  "maxSteps": 8 }
```
- `trigger`: event name, `*` suffix allowed · `when`: shallow equality on event data · `actions`: subset of the registry (the agent sees ONLY these) · actor = `{ kind: "automation", permissions }`.
- `mode: "dry_run"` (default): actions are recorded as *planned*, never executed — `preview(db, deps, spec, sampleEvent)` shows what it WOULD do. Flip to `live` once the plan looks right.

## Runtime
- `startAutomations(db, deps, loadSpecs)` subscribes to live-bus `event`. Schedules = the app publishing `cron.hourly` / `cron.daily` events (its job runner or a Railway cron) — no second scheduler.
- Idempotent: one run per (automation, event id) — a replayed webhook never double-acts.
- Every run → ai_automation_runs (status, planned/executed actions, error) + `ai.automation` on the bus; its model calls → ai_calls with `automation_run_id` (ai-analytics sums cost there).
- Task `automation` in llm-router (pick a strong tool-use model; cost shows per automation in `ai-report automations`).

## Rules
- New capability = new action in site-agent, then allow it here. Automations never get SQL or HTTP.
- Customer-visible side effects (messages) go through ai-channels / lifecycle-engine, not ad-hoc sends.
- With Marketing Kit: campaign-style sends stay in lifecycle-engine; automations handle data + 1:1 follow-ups.

## Works with →
`site-agent` (actions, prepareTurn) · `live-bus` (triggers + live runs) · `ai-analytics` (cost/outcomes) · `ml-lab` (predictions as triggers: churn risk, anomaly) · Marketing Kit `growth-data` (segments) / `lifecycle-engine` (sends).
