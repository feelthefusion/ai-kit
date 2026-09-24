---
name: ai-knowledge
description: "Use when the site's AI needs to know things: RAG / retrieval over products, FAQs, shipping and returns pages, policies-as-content, docs, order help and staff runbooks — ingesting and chunking content, embeddings (via llm-router's embed task or free local transformers.js models), pgvector hybrid search (vector + full-text, reciprocal rank fusion), audience filtering (public / customer / staff), and keeping the index current as the catalog changes (bus-driven re-index, content-hash dedupe)."
---

# AI Knowledge (what the bots know about THIS site)

File: `references/knowledge.ts` · table `ai_knowledge` (pgvector, one writer: this skill).

## Flow
1. **Ingest** `ingest(db, router, docs)` — `Doc = { source, sourceId, title, body, url, audience }`. Chunks (~800 chars, sentence-aware), `content_hash` per chunk → unchanged chunks are never re-embedded; stale chunks of the same source id are removed.
2. **Search** `search(db, router, query, audience, k)` — vector (cosine) + Postgres full-text, merged with reciprocal rank fusion. `audience` filters: a customer never retrieves a `staff` runbook. With a `decide` task, `rerank()` scores 3×k fused candidates in ONE typed call ("does passage i help answer the question?") and keeps the best k — sharper context for pennies; failure keeps fusion order. `AI_RERANK=off` skips it.
3. **Agent** `knowledgeFor(db, router)` → site-agent's `knowledge(query, audience)` dep: top hits as a short cited block in the instructions.

## Setup
- `create extension if not exists vector;` → the ai_knowledge table (ai-schema.ts) → the two indexes at the bottom of knowledge.ts (HNSW on `embedding vector_cosine_ops`, GIN on `to_tsvector('english', body)`).
- EMBED_DIMS must match the `embed` task model (changing models = new column/re-embed; ai-evolve never auto-swaps `embed`).
- Free/local option: `transformers-js` (e.g. a small sentence-embedding model in Node) exposed as a custom embed provider — no per-token cost.

## Keeping it living
- Subscribe to live-bus `event` (`product.updated`, `page.published`, `faq.changed`) → `ingest` just that source id. Nightly full re-ingest is a safety net, not the mechanism.
- Unanswered questions (ml-lab labels `intent` with no knowledge hit) → surface in the admin console as "add an FAQ" candidates.

## Works with →
`site-agent` (context) · `llm-router` (`router.embedding("embed")`) · `ml-lab` (similar products share the same vectors) · `live-bus` (re-index events) · `transformers-js`.
