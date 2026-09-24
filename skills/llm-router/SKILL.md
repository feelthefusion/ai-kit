---
name: llm-router
description: "Use when choosing, adding, switching or configuring LLMs / AI models / providers / API keys for a site: one OpenRouter key for every model, or per-provider keys (OpenAI, Anthropic, Google, xAI, Mistral, Groq, DeepSeek, Together, Fireworks, Cohere, Perplexity, Cerebras, Telnyx, Hugging Face, Ollama, Azure, Bedrock, Vertex, TypeSafe, any OpenAI-compatible), per-task model selection (chat, copilot, guard, channel replies, automation, summarize, classify, embed, decide), typed decisions with Jev (yes/no, pick-one, score + confidence via decide()), fallbacks on outages, the admin AI console (keys encrypted at rest, model pickers, test button, live feed). The ONLY place model calls originate."
---

# LLM Router (every model call, any provider, one config)

`references/providers.json` is the single catalog (package, factory, env names per provider) read
by the app AND by `ai-models` / `ai-doctor`. `references/providers.ts` resolves a **task** to a model;
`references/admin.ts` is the admin console API + DB-backed sources. App code never imports a provider
SDK — it asks `router.model("chat")`.

## Key modes (`ai-settings key-mode …` → AI_KEY_MODE)
| mode | how a ref like `anthropic:claude-x` is served | when |
|---|---|---|
| `openrouter` | through OpenRouter as `anthropic/claude-x` — ONE key, 300+ models | default when OPENROUTER_API_KEY is set |
| `byok` | the provider's own SDK + key; missing key → error naming the env var | you hold direct contracts |
| `mixed` | native when that provider's key exists, else OpenRouter | best of both (recommended once you add keys) |
Keys come from (first wins): admin console (ai_provider_keys, AES-256-GCM with AI_KEYS_SECRET) → env.
`ai-settings key <ENV>` writes CLI secrets + repo .env (+ Railway with `--railway`), read hidden.

## Tasks (repo defaults in `shared/ai-config.ts` → the admin DB setting wins; providers.json describes each task)
`chat` · `copilot` · `guard` (cheapest fast; runs before every customer turn) · `channel_reply` ·
`automation` · `summarize` · `classify` · `embed` (dims must equal EMBED_DIMS in ai-schema) · `decide`
(typed decisions, below). Add any task name — `router.model("my-task")` works once it has a setting.
Pick with `ai-models suggest`.

## Typed decisions — `decide.ts` (task `decide`)
A judgment your code acts on (route, gate, rank, verify) is a DECISION, not text: ask it as typed
questions and get probabilities back — nothing to parse, answers only from your options.
```ts
import { decide, pick, yes, level } from "./decide";
const d = await decide(router, { purpose: "triage", state: { message }, onCall: recordDecision(db), questions: {
  needs_reply: { type: "boolean", instructions: "Is this from a person expecting a reply?" },
  team: { type: "choice", instructions: "Who handles it?", criteria: { billing: "payments, refunds", shipping: "delivery, tracking" } },
  urgency: { type: "score", instructions: "How urgent?", criteria: ["routine", "soon", "urgent"] },
}});
yes(d, "needs_reply", 0.15) · pick(d, "team", 0.6) /* undefined when unsure */ · level(d, "urgency") /* 0..2 */
```
| `decide` ref | serves | key |
|---|---|---|
| `typesafe-ai:jev-1.13.0` (pin) / `typesafe-ai:jev-latest` | TypeSafe direct — fastest (≈0.3 s vs ≈0.7 s via OpenRouter in one published test) | `TYPESAFE_AI_API_KEY` or `TYPESAFE_API_KEY` |
| same ref in `openrouter` / `mixed` mode | OpenRouter Decisions API as `typesafe/jev-1.13` · `~typesafe/jev-latest` (exact cost reported) | `OPENROUTER_API_KEY` |
| `gateway:typesafe-ai/jev` | Vercel AI Gateway | `AI_GATEWAY_API_KEY` |
| `openai:` / `anthropic:` / `google:` `<small model>` | the provider's LLM-backed evaluation adapter — same questions, no calibrated distribution for choice/score | that provider's key |
Recommended: `decide: { model: "typesafe-ai:jev-1.13.0", fallbacks: ["<cheap openai|anthropic|google model>"] }`.
Jev pricing: $0.042 per M input tokens, output free; 32k context. Jev never writes text — `summarize`
and every reply stay on text models. Confidence: `d.confidence[id]` 0–1 (Jev's own for choice/score;
|2p−1| for yes/no; undefined from LLM adapters, where `pick` then trusts the answer like a classifier).
- Fallback chain works like text: 408/409/429/5xx/network → next ref; 4xx (bad question) throws.
- `router.has("decide")` gates every typed path — without the task each feature keeps its text path.
- Use the `typesafe-ai` skill (live TypeSafe docs) when writing questions: criteria are the definitions.
- Pin a version; ai-evolve's decision suite promotes a newer Jev only after it matches the site's cases.

## Wiring
```ts
import { createRouter } from "./providers";
import { dbSources, mountAiAdmin } from "./admin";
const defaults = { chat: { model: "anthropic:claude-sonnet-5", fallbacks: ["openai:gpt-5.4"] }, guard: { model: "google:gemini-3-flash" }, /* … */ };
export const router = createRouter({ ...dbSources(db, defaults), middleware: [/* analytics tap */] });
mountAiAdmin(adminRouter, db, router, defaults, (req) => req.user?.id);   // behind staff auth ("ai:admin")
```
(Model ids above are placeholders — take real ones from `ai-models`; never hard-code from memory.)
- Fallbacks: `fallbackMiddleware` retries the next model on 408/409/429/5xx/network — same call, no user-visible error.
- Settings changes publish `ai.settings` on live-bus → `router.invalidate()` everywhere; no restart.
- Retired models (ai-evolve catalog sync) fail over to the fallback chain automatically.

## Rules
- A new provider = one row in providers.json (+ `npm i @ai-sdk/<pkg>@latest`). Never a second code path.
- Model/vendor names are internal. They may appear in ai_calls and the admin console — never in customer UI, message metadata, response headers or errors.
- Read `use-ai-sdk` before touching provider code (v7 renamed/moved things); `openrouter-models` for slugs/capabilities.
- Cost: OpenRouter returns exact cost per call (`providerMetadata.openrouter.usage.cost`); BYOK cost is computed from ai_models pricing (refreshed by ai-evolve). Both land in ai_calls via ai-analytics.

## Works with →
`site-agent` (every agent gets its model here; guard stage 2 uses decide) · `ai-channels` (triage) · `ai-automations` (gates) · `ml-lab` (labels) · `ai-analytics` (middleware tap → ai_calls) · `ai-evolve` (writes ai_models, variants route through `pickVariant`) · `ai-knowledge` (`router.embedding`, rerank via decide) · `live-bus` (settings invalidation).
