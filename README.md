# AI Kit — chat, email & SMS bots, safe site automation, and living AI for sites and apps

**One AI brain per site: web chat bot + admin copilot + email bot + SMS bot + background automations — all the same agent, changing site data only through safe, signed, audited actions — on any LLM (one OpenRouter key or every provider's own key), with visitor identification (FingerprintJS), live SSE + webhooks, AI tracking + analytics, and models + prompts that keep improving themselves behind an eval gate.**

Live installs, never vendored. Kit skills are symlinked into your checkout; curated upstream skills (Vercel AI SDK, AI Elements, OpenRouter, Hugging Face, promptfoo, Anthropic's MCP builder) are fetched from their own repos; vendor packs (Resend, Telnyx) install from their own marketplaces. One command wires both hosts, and it **updates itself + every skill on each session start** (no timers) — and tells you when the app's AI packages fall behind npm.

```bash
curl -fsSL https://raw.githubusercontent.com/feelthefusion/ai-kit/main/install/bootstrap.sh | bash   # Claude Code + Hermes
cd <app repo> && ai-init        # once per repo: .agents/ai-stack.md, evals/, instructions, links, verify step
ai-settings key OPENROUTER_API_KEY    # one key → every model  (or per provider: ai-models providers)
ai-settings secrets             # AI_APPROVAL_SECRET (signs write approvals) + AI_KEYS_SECRET (encrypts console keys)
ai-models suggest               # pick a model per task from the live catalog
ai-doctor                       # everything wired → GREEN
```

`... | bash -s -- claude` or `... -s -- hermes` installs a single host.

## Components

| # | Skill | Does | Hand-off to |
|---|-------|------|-------------|
| — | **ai-kit** | The map: which component owns each job, data flow, conflict rules | (loads on any AI task) |
| 1 | **llm-router** | Every model call. Key modes `openrouter` (one key, any model) · `byok` (each provider's SDK + key: OpenAI, Anthropic, Google, xAI, Mistral, Groq, DeepSeek, Together, Fireworks, Cohere, Perplexity, Cerebras, Azure, Bedrock, Vertex, Ollama, any OpenAI-compatible) · `mixed`. Model per task, fallbacks on outages, admin AI console (keys AES-GCM encrypted, pickers, test button, live feed) | every AI surface |
| 2 | **site-agent** | The one agent behind every surface. Action registry = the only way AI changes data (zod inputs, permissions, customer id from the session, HMAC-signed confirm cards for writes, audit + live events). Identity lock ("a custom-built assistant developed for <site>" — never the model/vendor) + site-only scope lock. Web widget, server-side history, eval endpoint, site-ops MCP | llm-router, ai-knowledge, visitor-intel |
| 3 | **visitor-intel** | FingerprintJS visitor id (OSS default, Pro optional: bot/VPN/incognito/tampering), cross-device stitching, live presence, intent scoring, context for the bots | live-bus, ml-lab |
| 4 | **ai-channels** | Email bot + SMS bot on the same agent: verified-sender identity, threads, "Reply YES to confirm", loop brake, human handoff | Marketing Kit lifecycle-engine (sending) |
| 5 | **ai-knowledge** | RAG over products, FAQs, pages, runbooks: pgvector + full-text hybrid, audience-filtered, re-indexed on change | site-agent |
| 6 | **ai-automations** | Event-driven AI jobs with a narrow action set, dry-run by default, idempotent per event, streamed live | site-agent, live-bus |
| 7 | **live-bus** | One event spine: SSE (admin live console, customer toasts, replay on reconnect), Standard Webhooks in/out, multi-instance fan-out — generalizes helix's live visitors | everything live |
| 8 | **ai-analytics** | The only writer of AI numbers: calls, tokens, exact cost, latency, outcomes, CSAT, confirm acceptance, AI-attributed revenue, cost per resolution, guard stops — `ai-report` + dashboard SQL | Marketing Kit journey-analytics (site tracking) |
| 9 | **ai-evolve** | Living models + prompts: catalog watch, challengers, eval gate (the real pipeline, dry-run), sticky canary, promote on outcomes with a z-test, auto-failover on retirement; promptfoo evals + red team | llm-router, ai-analytics |
| 10 | **ml-lab** | ML on the site's own data: conversation labels, purchase-intent model (held-out AUC-gated), similar products, spend anomalies; fine-tunes via Hugging Face | visitor-intel, ai-evolve |

CLIs: `ai-init` · `ai-doctor` · `ai-settings` · `ai-models` · `ai-report` · `ai-eval` · `ai-mcp` · `ai-update` · `ai-webhooks`.

### Curated upstream skills (fetched live)
`use-ai-sdk` · `ai-elements` (Vercel) · `openrouter-models` · `openrouter-benchmarks` · `openrouter-generations` · `openrouter-analytics` (OpenRouter) · `mcp-builder` (Anthropic) · `transformers-js` · `huggingface-local-models` · `huggingface-llm-trainer` · `huggingface-datasets` (Hugging Face) · `promptfoo-evals` · `promptfoo-provider-setup` · `promptfoo-redteam-setup` · `promptfoo-redteam-run` (promptfoo). Vendor packs: Resend (`agent-email-inbox` … — Claude Code; Hermes' scanner blocks it, `ai-channels` covers it there), Telnyx AI (`telnyx-ai-assistants-javascript`, `telnyx-ai-inference-javascript` …).
Deliberately **not** installed: vendor-SDK skills (`claude-api`, `openai-docs`, `gemini-api-dev`) — the AI SDK behind llm-router is the one integration layer.

## How it fits with your other kits
**→ Marketing Kit**: site-wide tracking stays in `journey-analytics` (AI events forwarded as `ai.*` into crm_events — one tracker); email/SMS sending stays in `lifecycle-engine` (one sender); model/prompt variants register as `growth-optimizer` arms when present (one experiment engine); churn/CLV scores stay there, ml-lab supplies features. `ai-init` appends an AI hand-off block to `.agents/growth-stack.md`.
**→ Security Kit**: `ai-init` appends the AI attack surface (chat, eval, MCP, hooks, admin endpoints + the invariants to attack) to `.agents/security-context.md`; `red-team` / `exploit-verify` cover it; `ai-eval redteam` is the LLM-specific pass; fixed holes become `evals/cases.json` rows.
**→ Skill Starter Kit**: `verify.sh` gains an `AI guard tests` step (`ai:test`); `docs-freshness` before new AI deps; `browser-verify` for the widget; `consistency` for anything the bot shows that other pages show.
The kit's brain check fails if any AI Kit skill name collides with a Marketing Kit or Security Kit skill.

## Proven, not promised
`bash tests/run.sh` — the reference code is typechecked and behaviour-tested against **today's `npm i` (every dep @latest)** with mock models: identity probes never reach a model; vendor names are scrubbed even when split across stream chunks; reasoning never reaches the browser; customers never see staff tools; writes wait for an HMAC-signed approval and run with the session's customer id; a tampered approval never executes; a real Express server streams a scrubbed reply over HTTP; SMS "YES" executes only for the carrier-verified customer; a failing challenger model falls back to the champion; the eval gate passes a good model and fails a lazy one without writing anything; the intent model learns a real signal. The analytics SQL runs on real Postgres against the schema drizzle-kit generates, with hand-computed expected numbers. Updates are tested offline against local bare repos.

## Freedom-first
- No legal/compliance text of the kit's own — no T&Cs, no policies, no disclaimers, no gating. Unlicense (public domain).
- The only behaviour rules are product rules you asked for: bots stay on the site they're installed on and never reveal what powers them.
- Third-party skills keep their authors' licenses (fetched live, never redistributed); legal sections inside them are background only.
