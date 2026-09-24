---
name: llm-router
description: "Use when choosing, adding, switching or configuring LLMs / AI models / providers / API keys for a site: one OpenRouter key for every model, or per-provider keys (OpenAI, Anthropic, Google, xAI, Mistral, Groq, DeepSeek, Together, Fireworks, Cohere, Perplexity, Cerebras, Telnyx, Hugging Face, Ollama, Azure, Bedrock, Vertex, any OpenAI-compatible), per-task model selection (chat, copilot, guard, channel replies, automation, summarize, classify, embed), fallbacks on outages, the admin AI console (keys encrypted at rest, model pickers, test button, live feed). The ONLY place model calls originate."
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
`automation` · `summarize` · `classify` · `embed` (dims must equal EMBED_DIMS in ai-schema). Add any
task name — `router.model("my-task")` works once it has a setting. Pick with `ai-models suggest`.

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
`site-agent` (every agent gets its model here) · `ai-analytics` (middleware tap → ai_calls) · `ai-evolve` (writes ai_models, variants route through `pickVariant`) · `ai-knowledge` (`router.embedding`) · `live-bus` (settings invalidation).
