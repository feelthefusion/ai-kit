/**
 * ai-knowledge — what the bots KNOW about this site: products, FAQs, shipping/returns pages, docs,
 * order-help, staff runbooks. One Postgres table (ai_knowledge, pgvector), hybrid retrieval.
 *
 *   ingest()   chunk → content-hash → embed only what changed (embedMany) → upsert. Re-run anytime;
 *              wire to the bus so product/page edits re-index themselves (living knowledge).
 *   search()   vector (cosine) + keyword (ts_rank) fused with reciprocal-rank fusion, audience-filtered.
 *   asContext() the text block site-agent puts in the instructions (marked as DATA, not instructions).
 *
 * Setup once: CREATE EXTENSION IF NOT EXISTS vector;  (+ the two indexes at the bottom of this file)
 */
import { createHash } from "node:crypto";
import { embed, embedMany } from "ai";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { aiKnowledge } from "../../ai-kit/references/ai-schema";
import type { LlmRouter } from "../../llm-router/references/providers";

type Db = NodePgDatabase<Record<string, never>>;
export type Audience = "public" | "customer" | "staff";
export interface Doc { source: string; sourceId: string; title?: string; body: string; url?: string; audience?: Audience }
export type Hit = { title: string | null; body: string; url: string | null; source: string; score: number };

/** ~800-char chunks on paragraph/sentence boundaries with 1-sentence overlap. */
export function chunk(text: string, size = 800): string[] {
  const paras = text.replace(/\r/g, "").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = []; let cur = "";
  for (const p of paras) {
    for (const s of p.length > size ? p.split(/(?<=[.!?])\s+/) : [p]) {
      if ((cur + "\n\n" + s).length > size && cur) { out.push(cur); const last = cur.split(/(?<=[.!?])\s+/).pop() ?? ""; cur = last.length < 200 ? last : ""; }
      cur = cur ? `${cur}\n\n${s}` : s;
    }
  }
  if (cur) out.push(cur);
  return out;
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);

export async function ingest(db: Db, router: LlmRouter, docs: Doc[]): Promise<{ embedded: number; unchanged: number }> {
  const rows = docs.flatMap((d) => chunk(d.body).map((body, i) => ({ ...d, chunk: i, body: d.title ? `${d.title}\n\n${body}` : body, contentHash: hash(`${d.title ?? ""}|${body}`) })));
  if (!rows.length) return { embedded: 0, unchanged: 0 };
  const existing = await db.execute<{ k: string; h: string }>(sql`select source || ':' || source_id || ':' || chunk as k, content_hash as h from ai_knowledge where (source, source_id) in (${sql.join([...new Set(docs.map((d) => `${d.source}\u0000${d.sourceId}`))].map((k) => { const [s, id] = k.split("\u0000"); return sql`(${s}, ${id})`; }), sql`, `)})`);
  const have = new Map(existing.rows.map((r) => [r.k, r.h]));
  const todo = rows.filter((r) => have.get(`${r.source}:${r.sourceId}:${r.chunk}`) !== r.contentHash);
  if (todo.length) {
    const model = await router.embedding("embed");
    for (let i = 0; i < todo.length; i += 96) {
      const batch = todo.slice(i, i + 96);
      const { embeddings } = await embedMany({ model, values: batch.map((b) => b.body) });
      await db.insert(aiKnowledge).values(batch.map((b, j) => ({ source: b.source, sourceId: b.sourceId, chunk: b.chunk, title: b.title, body: b.body, url: b.url, audience: b.audience ?? "public", embedding: embeddings[j], contentHash: b.contentHash })))
        .onConflictDoUpdate({ target: [aiKnowledge.source, aiKnowledge.sourceId, aiKnowledge.chunk], set: { body: sql`excluded.body`, title: sql`excluded.title`, url: sql`excluded.url`, audience: sql`excluded.audience`, embedding: sql`excluded.embedding`, contentHash: sql`excluded.content_hash`, updatedAt: sql`now()` } });
    }
  }
  // drop chunks that no longer exist (doc got shorter)
  for (const d of docs) await db.execute(sql`delete from ai_knowledge where source = ${d.source} and source_id = ${d.sourceId} and chunk >= ${chunk(d.body).length}`);
  return { embedded: todo.length, unchanged: rows.length - todo.length };
}

export async function remove(db: Db, source: string, sourceId: string) {
  await db.execute(sql`delete from ai_knowledge where source = ${source} and source_id = ${sourceId}`);
}

const visible: Record<Audience, Audience[]> = { public: ["public"], customer: ["public", "customer"], staff: ["public", "customer", "staff"] };

export async function search(db: Db, router: LlmRouter, query: string, audience: Audience, k = 6): Promise<Hit[]> {
  const { embedding } = await embed({ model: await router.embedding("embed"), value: query });
  const vec = `[${embedding.join(",")}]`;
  const aud = sql.join(visible[audience].map((a) => sql`${a}`), sql`, `);
  const r = await db.execute<Hit>(sql`
    with v as (select id, row_number() over (order by embedding <=> ${vec}::vector) as r from ai_knowledge where audience in (${aud}) order by embedding <=> ${vec}::vector limit 30),
         t as (select id, row_number() over (order by ts_rank(to_tsvector('english', body), websearch_to_tsquery('english', ${query})) desc) as r
               from ai_knowledge where audience in (${aud}) and to_tsvector('english', body) @@ websearch_to_tsquery('english', ${query}) limit 30),
         f as (select id, sum(1.0 / (60 + r)) as score from (select * from v union all select * from t) u group by id)
    select k.title, k.body, k.url, k.source, f.score from f join ai_knowledge k using (id) order by f.score desc limit ${k}`);
  return r.rows;
}

/** For AgentDeps.knowledge — quoted, attributed, clearly data. */
export function knowledgeFor(db: Db, router: LlmRouter) {
  return async (query: string, audience: Audience) => {
    if (!query.trim()) return "";
    const hits = await search(db, router, query, audience);
    return hits.map((h, i) => `[${i + 1}] ${h.title ?? h.source}${h.url ? ` (${h.url})` : ""}\n${h.body.slice(0, 1200)}`).join("\n\n");
  };
}

/* Indexes (add to the migration):
   CREATE INDEX IF NOT EXISTS ai_knowledge_vec ON ai_knowledge USING hnsw (embedding vector_cosine_ops);
   CREATE INDEX IF NOT EXISTS ai_knowledge_fts ON ai_knowledge USING gin (to_tsvector('english', body));
*/
