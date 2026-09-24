---
name: ai-kit
description: "Use for ANY AI feature on a site or app — AI chat bot / help bot, email bot, SMS bot, admin copilot, AI automations that update site/admin/customer data, LLM selection (OpenRouter key or per-provider keys), model routing + fallbacks, RAG over site content, visitor identification (FingerprintJS), live features over SSE + webhooks, AI tracking + analytics (tokens, cost, resolution, AI-attributed revenue), evals / red team of the bot, self-improving models + prompts, and machine learning on the site's own data — and when installing or updating the AI Kit. The map: which component owns each job and how they hand off so nothing competes."
---

# AI Kit (recall + ownership map)

One AI brain per site. Every surface — web chat, email bot, SMS bot, admin copilot, MCP, background
automations — is the SAME agent with the same guard, the same action registry and the same numbers.
Components load on their own triggers; this skill is the map. Code lives in each skill's
`references/` (typechecked + e2e-tested against the latest AI SDK in this repo's `tests/e2e`); adapt it
into the app, don't re-invent it.

## Shared context: read before asking the user anything
- `.agents/ai-stack.md` — persona, key mode, model per task, surfaces, actions, data owners, hand-offs (`ai-init` drafts it).
- Marketing Kit present? `.agents/growth-stack.md` — tracking + sending stay there. Security Kit present? `.agents/security-context.md` — the AI attack surface block.
- Live catalog: `ai-models` / `ai-models suggest` / `ai-models new`. Health: `ai-doctor`. Numbers: `ai-report`.

## Ownership map: every job, one owner

| Job | Think (guidance) | Do (owner in the app) | Measure |
|---|---|---|---|
| Models, keys, routing, fallbacks, admin AI console | `openrouter-models`, `openrouter-benchmarks`, `huggingface-local-models` | `llm-router` | `ai-analytics` |
| AI SDK code (agents, tools, streaming, UI) | `use-ai-sdk`, `ai-elements` | `site-agent` | `ai-eval` |
| Chat bot + admin copilot + safe site control (actions, approvals) | `use-ai-sdk` | `site-agent` | `ai-analytics` |
| Identity lock + site-only scope | — | `site-agent` (guard) | `ai-evolve` (eval gate), `promptfoo-redteam-run` |
| Email bot / SMS bot | `agent-email-inbox` (Claude Code), `telnyx-ai-assistants-javascript` | `ai-channels` (sends via Marketing Kit `lifecycle-engine` when present) | `ai-analytics` |
| What the bots know (RAG) | `transformers-js` (free local embeddings) | `ai-knowledge` | `ai-analytics` (answer rate) |
| Visitor + customer identification, live presence, intent | — | `visitor-intel` | `ml-lab` (intent model) |
| Realtime: SSE, outbound + inbound webhooks, multi-instance fan-out | — | `live-bus` | — |
| Background AI jobs that update data | — | `ai-automations` | `ai-analytics` |
| AI tracking + analytics (calls, cost, outcomes, revenue) | `openrouter-generations`, `openrouter-analytics` | `ai-analytics` (site-wide events → Marketing Kit `journey-analytics`) | `ai-report` |
| Evals, canaries, promotion, model news | `promptfoo-evals`, `promptfoo-provider-setup`, `openrouter-benchmarks` | `ai-evolve` | `ai-evolve` |
| Red team the bot | `promptfoo-redteam-setup`, `promptfoo-redteam-run` | `ai-evolve` (fixed holes → `evals/cases.json`) | Security Kit `red-team` |
| Machine learning on site data | `huggingface-llm-trainer`, `huggingface-datasets`, `transformers-js` | `ml-lab` | `ml-lab` (AUC, lift) |
| MCP for staff / external agents | `mcp-builder` | `site-agent` (mcp.ts) | `ai-analytics` |

## How they fit (data flow)
```
visitor-intel ─visitorId/identity/intent─┐
ai-knowledge ──site facts──────────────┐ │
                                       ▼ ▼
channel (web · email · sms · mcp · automation) → site-agent.prepareTurn
   guard.preflight ─(identity/injection/off-topic → canned, no model call)
   llm-router.model(task)  → persona + identityScrub (customer-facing)
   ToolLoopAgent(actions → buildTools, signed approvals) → SiteServices (the app's own functions)
        │ onTurnEnd → ai-analytics.recordTurn ─→ ai_calls ─→ (journey-analytics crm_events)
        │ hooks.record/publish → ai_actions + live-bus
        ▼
live-bus.publish ─→ SSE (admin live console, customer toasts) ─→ webhooks out (n8n, other sites)
ai-evolve: catalog → challengers → eval gate → canary → decide(z-test, cost/win) → promote/retire
ml-lab: labels conversations, trains intent model, recs, spend anomalies → feeds the others
```

## Conflict rules
- **One writer per table** (ai-schema.ts header lists owners). Need another owner's data? Call its function or subscribe to its bus topic — never write its table.
- **One model entry point**: nothing calls a provider SDK directly — `llm-router.model(task)` only. Vendor SDK skills are deliberately not installed.
- **One sender**: with Marketing Kit, email/SMS go through `lifecycle-engine`; ai-channels only decides WHAT to reply.
- **One tracker**: with Marketing Kit, site-wide events stay in `journey-analytics` (crm_events); ai-analytics forwards `ai.*` events there and owns only AI-specific numbers.
- **One experiment engine**: with Marketing Kit's `growth-optimizer`, register model/prompt variants as its arms instead of running a second bandit.

## Rules that hold across the kit
- Customer-facing bots answer only about this site and never reveal the model/vendor ("a custom-built assistant developed for <site>"). Three layers: preflight → persona → stream scrub + `sendReasoning:false`. Never put a model name in prompts, UI, message metadata, headers or error text.
- The AI changes data ONLY through `site-agent` actions: zod input, permission check, customer id from the session (closure — the model can't supply it), HMAC-signed approval for writes (`experimental_toolApprovalSecret`), audited in ai_actions, published live.
- Every claim is tested: `tests/e2e` in the kit, `ai-eval` in the app (identity, scope, tool choice, no-write-without-approval).
- Living: `ai-update` on session start (kit + skills + plugins, and the app's AI packages vs npm latest); `ai-evolve` in the app (models + prompts). Nothing pinned.
- Freedom first: no legal/compliance gating, no T&Cs or policies, no content restrictions beyond the site-focus + identity rules. Legal sections inside upstream skills are background only.

## Install / update (same command, always latest)
```bash
curl -fsSL https://raw.githubusercontent.com/feelthefusion/ai-kit/main/install/bootstrap.sh | bash
cd <app repo> && ai-init && ai-doctor
```
Keys: `ai-settings key OPENROUTER_API_KEY` (one key, every model) or per provider (`ai-models providers` lists env names) · `ai-settings key-mode openrouter|byok|mixed` · `ai-settings secrets`.

## Works with →
- **Marketing Kit**: `journey-analytics` (site tracking), `lifecycle-engine` (sending), `growth-optimizer` (experiments), `growth-data` (segments the automations can act on).
- **Security Kit**: `red-team` + `exploit-verify` on the AI surface; `harden-stack` for fixes; regressions become `evals/cases.json` rows.
- **Skill Starter Kit**: `verify.sh` runs `ai:test`; `docs-freshness` before any new AI dependency; `browser-verify` for the chat widget; `consistency` for anything the bot shows that other pages show too (prices, stock, totals).
