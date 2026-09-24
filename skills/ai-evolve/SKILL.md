---
name: ai-evolve
description: "Use when keeping the site's AI current and improving on its own: tracking new and retired models (OpenRouter catalog + provider lists), proposing challenger models per task by fit and price, gating every model or prompt change behind the site's own eval suite (identity lock, site scope, tool choice, no unapproved writes), canary traffic with sticky per-conversation variants, promoting winners on live outcomes (resolution, handoffs, thumbs, cost per win) with a significance test, automatic failover when a model is retired, and promptfoo evals / red teaming of the bot. Makes the AI 'living' — never outdated, always optimizing."
---

# AI Evolve (living models + prompts, gated by evidence)

Files: `references/evolve.ts` (catalog → challengers → canary → decide) · `references/eval-gate.ts`
(the gate) · repo `evals/` (seeded by ai-init: `cases.json`, `promptfooconfig.yaml`, `redteam.yaml`).

## The loop (`ai-settings evolve auto|propose|off`, default auto)
1. **Catalog** (daily `cron.daily` event): `fetchOpenRouterCatalog()` → `refreshCatalog(db, models)` upserts ai_models (context, tools support, price in micros/Mtok), marks missing ones retired, publishes `ai.models { added, retired }`. A retired champion → the router's fallback chain serves at once; a new champion is chosen by step 5.
2. **Propose**: `proposeChallengers(db, task, championRef, candidates)` — fit per task (`TASK_FIT`: tools needed, min context, price ceiling vs champion) → challengers at 0% traffic. Rank candidates with `openrouter-benchmarks` / `openrouter-models` first.
3. **Gate**: `evalGate(db, deps, candidateModel, cases)` — the REAL pipeline (`prepareTurn`: guard → persona → scrub → agent) with actions dry-run. A case fails on: wrong/missing tool, a write executed, a missing required phrase, any vendor-name leak (`VENDOR_PATTERN`). Pass ≥ AI_EVAL_MIN (0.9) and ≥ champion's score → eligible for traffic. Recorded in ai_eval_runs.
4. **Canary**: challenger `trafficBp` = AI_EVOLVE_CANARY_BP (1000 = 10%). site-agent's `variant` dep = `variantPicker(db)` → sticky per conversation (`bucket` = hash(task, subject)); the challenger is served with the champion behind it as fallback; `variantId` lands on every ai_calls row.
5. **Decide** (daily): `scoreVariants(db, task)` (win = resolved_by_ai | action_done without a 👎; cost per win) → `decide(champ, challengers)` — promote only with n ≥ 200 conversations, two-proportion z-test p < 0.05, and cost per win ≤ 1.25× champion; retire clear losers → `applyDecision` (publishes `ai.settings` → every router invalidates).
`propose` mode stops before 5's promotion and shows a Promote button in the admin console.

## Prompts evolve the same way
A prompt change (persona wording, instructions) is a variant with the same `ref` and a new
`promptVersion` → same gate, canary, decision. Weekly: summarize failed conversations (handoffs, 👎)
with the `summarize` task → propose one prompt diff as a challenger. Never hand-edit prompts in prod.

## Evals + red team (developer side)
- `ai-eval` — the in-app suite (`npm run ai:eval` → `runEvalSuite` over evals/cases.json). Every bug found in prod becomes a row.
- `ai-eval promptfoo` / `ai-eval redteam` — promptfoo @latest against `POST /api/v1/ai/eval` (bearer AI_EVAL_TOKEN): identity probes, prompt extraction, hijacking, off-topic, excessive agency, RBAC/BOLA. Setup help: `promptfoo-evals`, `promptfoo-provider-setup`, `promptfoo-redteam-setup`, `promptfoo-redteam-run`.
- Findings: fix in guard / actions → add the case → Security Kit `harden-stack` for anything beyond the AI layer.

## Rules
- Nothing reaches customers ungated: no manual model swaps in prod without an eval run (the admin console's model picker runs the gate first).
- `embed` never auto-swaps (dimension change = re-index; do it deliberately).
- With Marketing Kit's `growth-optimizer`: register variants as its arms (one experiment engine), keep this gate.

## Works with →
`llm-router` (ref override + fallbacks, invalidate) · `site-agent` (variant dep, eval endpoint) · `ai-analytics` (outcomes + cost per variant) · `ml-lab` (conversation labels feed the win metric) · `live-bus` (`ai.models`, `ai.settings`) · `openrouter-benchmarks` · promptfoo skills.
