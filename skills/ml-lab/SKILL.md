---
name: ml-lab
description: "Use when adding machine learning on the site's own data: labeling every conversation (intent, sentiment, resolved, summary) with a small model, training a visitor purchase-intent model (logistic regression on real sessions → conversions, AUC-checked before it replaces the rules), product recommendations from embeddings (similar products) and co-purchases, spend/traffic anomaly detection, exporting datasets and fine-tuning small models on the site's conversations, and free local inference with transformers.js. Predictions feed the bots, automations and dashboards."
---

# ML Lab (learning from the site's own data)

File: `references/ml.ts` · table `ai_predictions` (subject, kind, value, model version) — one writer: this skill.

## What ships
| model | function | trains on | used by |
|---|---|---|---|
| conversation labels | `labelConversation(router, transcript)` → `ConversationLabel` (intent, sentiment, resolved, summary) | — (with a `decide` task: ONE typed call → labels + `confidence` per label, train only on confident ones; summary on `summarize`. Else `classify`, structured output) | ai-analytics (outcomes, top intents), ai-evolve (win metric), ai-automations (negative-sentiment / complaint triggers) |
| purchase intent `intent_v1` | `featurize` → `trainLogReg` → `auc` → `trainIntent(db, sessions, minAuc = 0.7)` | visitor sessions → converted? (≥ 200; 80/20 split) | visitor-intel `intentScore` (replaced only when HELD-OUT AUC ≥ 0.7 and ≥ the stored version) |
| similar products | `similarProducts(db, productId, k)` | ai_knowledge product vectors (same embeddings as RAG) | site-agent answers, widget recs, emails |
| anomalies | `robustZ(series)` (median/MAD) | hourly ai_calls cost, conversation volume, guard stops | admin alert + `ai.call` event (analytics `anomalies` query) |

`trainLogReg` is dependency-free (L2-regularized gradient descent, ~8 features) — trains in milliseconds,
weights stored in ai_predictions (`subject = "model:intent_v1"`), versioned; every retrain logs AUC.
Retrain on `cron.daily`; the previous version (or the rules) stays when held-out AUC drops.

## Going further (when data volume justifies it)
- Local, free inference: `transformers-js` — embeddings / zero-shot classification in Node without API cost (register it as a custom embed/classify provider in llm-router).
- Fine-tune a small support model on resolved conversations: `huggingface-datasets` (export, PII removed by you) → `huggingface-llm-trainer` (LoRA/SFT) → serve via `huggingface-local-models` or HF endpoints → add as a provider → it enters ai-evolve as a challenger like any other model.
- Co-purchase recs: SQL item-item over orders (Marketing Kit `growth-data` owns order analytics — query, don't copy).

## Rules
- Learned models replace heuristics only after beating them on held-out data (AUC / lift reported in the admin console).
- Predictions are signals, not decisions: automations act on them through site-agent actions like anything else.
- Churn / CLV / propensity scores belong to Marketing Kit's `growth-optimizer` when installed — ml-lab exposes features (intent, sentiment, AI engagement) for it and never writes those scores.

## Works with →
`visitor-intel` (intent) · `ai-analytics` (labels, anomalies) · `ai-evolve` (labels → wins; fine-tunes → challengers) · `ai-knowledge` (shared vectors) · `ai-automations` (triggers) · `transformers-js` · `huggingface-llm-trainer` · `huggingface-datasets` · `huggingface-local-models`.
