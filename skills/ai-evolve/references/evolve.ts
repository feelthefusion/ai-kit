/**
 * ai-evolve — keeps every AI surface on the best model + prompt, automatically, forever.
 *
 *   catalog   refreshCatalog(): OpenRouter's public catalog (+ each BYOK provider's /models) → ai_models.
 *             New ids → "ai.models" event; a retired champion fails over to its fallback at once.
 *   propose   proposeChallengers(): new models that fit the task (tools, context, price ceiling) become
 *             challengers at 0% traffic.
 *   gate      ai-eval (promptfoo suite incl. identity + scope + action tests) must pass ≥ champion
 *             score before any traffic. Recorded in ai_eval_runs.
 *   canary    passing challengers get AI_EVOLVE_CANARY_BP (default 1000 = 10%) via pickVariant().
 *   judge     live outcomes per variant (resolution, handoff, thumbs, CSAT, cost) → two-proportion
 *             z-test → promote (champion) or retire. Every change publishes "ai.settings" so routers
 *             invalidate and the console updates live.
 *
 * AI_EVOLVE=auto (default) runs the whole loop; propose = stop before promotion (console button);
 * off = catalog refresh only. If marketing-kit's growth-optimizer is installed, register variants as
 * its arms instead of running a second experiment engine (one experiment brain).
 */
import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { aiModels, aiVariants } from "../../ai-kit/references/ai-schema";
import { publish, subscribe } from "../../live-bus/references/bus";

type Db = NodePgDatabase<Record<string, never>>;

interface OrModel {
  id: string; name?: string; context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
}

/** $ per token (string) → micro-dollars per million tokens. */
const perMtok = (p?: string) => (p && Number.isFinite(Number(p)) ? Math.round(Number(p) * 1e12) : null);

export async function fetchOpenRouterCatalog(fetchFn: typeof fetch = fetch): Promise<OrModel[]> {
  const r = await fetchFn("https://openrouter.ai/api/v1/models", { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`catalog ${r.status}`);
  return ((await r.json()) as { data: OrModel[] }).data;
}

export async function refreshCatalog(db: Db, models: OrModel[]): Promise<{ added: string[]; retired: string[] }> {
  const refs = models.map((m) => `openrouter:${m.id}`);
  const before = new Set((await db.select({ ref: aiModels.ref }).from(aiModels).where(isNull(aiModels.retiredAt))).map((r) => r.ref));
  for (const m of models) {
    const row = {
      ref: `openrouter:${m.id}`, provider: "openrouter", modelId: m.id, name: m.name, contextLength: m.context_length,
      inputMicrosPerMtok: perMtok(m.pricing?.prompt), outputMicrosPerMtok: perMtok(m.pricing?.completion),
      tools: m.supported_parameters?.includes("tools") ?? null,
      modalities: { input: m.architecture?.input_modalities, output: m.architecture?.output_modalities },
    };
    await db.insert(aiModels).values(row).onConflictDoUpdate({ target: aiModels.ref, set: { ...row, lastSeenAt: sql`now()`, retiredAt: null } });
  }
  const retiredRows = refs.length
    ? await db.update(aiModels).set({ retiredAt: sql`now()` }).where(and(eq(aiModels.provider, "openrouter"), notInArray(aiModels.ref, refs), isNull(aiModels.retiredAt))).returning({ ref: aiModels.ref })
    : [];
  const added = refs.filter((r) => !before.has(r));
  const retired = retiredRows.map((r) => r.ref);
  if (added.length || retired.length) publish("ai.models", { added, retired });
  return { added, retired };
}

export interface Fit { needsTools: boolean; minContext: number; maxPriceRatio: number; textOut: boolean }
export const TASK_FIT: Record<string, Fit> = {
  chat: { needsTools: true, minContext: 32_000, maxPriceRatio: 1.5, textOut: true },
  channel_reply: { needsTools: true, minContext: 32_000, maxPriceRatio: 1.5, textOut: true },
  copilot: { needsTools: true, minContext: 64_000, maxPriceRatio: 2, textOut: true },
  automation: { needsTools: true, minContext: 32_000, maxPriceRatio: 1.5, textOut: true },
  guard: { needsTools: false, minContext: 8_000, maxPriceRatio: 1, textOut: true },
  classify: { needsTools: false, minContext: 8_000, maxPriceRatio: 1, textOut: true },
  summarize: { needsTools: false, minContext: 32_000, maxPriceRatio: 1.2, textOut: true },
};

/** Candidate filter; ranking by quality is the openrouter-benchmarks skill's job (agent-side). */
export async function proposeChallengers(db: Db, task: string, championRef: string, candidates: string[], limit = 2): Promise<string[]> {
  const fit = TASK_FIT[task] ?? TASK_FIT.chat;
  const [champ] = await db.select().from(aiModels).where(eq(aiModels.ref, championRef)).limit(1);
  const pool = candidates.length ? await db.select().from(aiModels).where(and(inArray(aiModels.ref, candidates), isNull(aiModels.retiredAt))) : [];
  const champPrice = (champ?.inputMicrosPerMtok ?? 0) + (champ?.outputMicrosPerMtok ?? 0);
  const ok = pool.filter((m) => (!fit.needsTools || m.tools) && (m.contextLength ?? 0) >= fit.minContext && (!fit.textOut || (m.modalities?.output ?? ["text"]).includes("text"))
    && (!champPrice || ((m.inputMicrosPerMtok ?? Infinity) + (m.outputMicrosPerMtok ?? Infinity)) <= champPrice * fit.maxPriceRatio)).slice(0, limit);
  for (const m of ok) await db.insert(aiVariants).values({ task, ref: m.ref, status: "challenger", trafficBp: 0 });
  return ok.map((m) => m.ref);
}

/** Deterministic bucket 0..9999 per (task, subject) so a visitor keeps the same variant. */
export function bucket(task: string, subject: string): number {
  return parseInt(createHash("sha256").update(`${task}:${subject}`).digest("hex").slice(0, 8), 16) % 10_000;
}

export interface VariantRow { id: string; ref: string; status: string; trafficBp: number; promptVersion: string }
/** Use inside llm-router's taskSetting(): champion unless the subject lands in a live challenger's slice. */
export function pickVariant(variants: VariantRow[], task: string, subject: string): VariantRow | undefined {
  const champion = variants.find((v) => v.status === "champion");
  let b = bucket(task, subject);
  for (const v of variants.filter((x) => x.status === "challenger" && x.trafficBp > 0)) { if (b < v.trafficBp) return v; b -= v.trafficBp; }
  return champion;
}

/** Two-proportion z-test (one-sided: is B better than A?). */
/** site-agent `variant` dep: live variants (cached briefly, invalidated on "ai.settings") → sticky pick per subject. */
export function variantPicker(db: Db, ttlMs = 60_000) {
  let at = 0; let rows: (VariantRow & { task: string })[] = [];
  subscribe(["ai.settings"], () => { at = 0; });
  return async (task: string, subject: string) => {
    if (Date.now() - at > ttlMs) {
      rows = (await db.select({ id: aiVariants.id, task: aiVariants.task, ref: aiVariants.ref, status: aiVariants.status, trafficBp: aiVariants.trafficBp, promptVersion: aiVariants.promptVersion })
        .from(aiVariants).where(inArray(aiVariants.status, ["champion", "challenger"]))) as never;
      at = Date.now();
    }
    const v = pickVariant(rows.filter((r) => r.task === task), task, subject);
    return v ? { variantId: v.id, ref: v.ref } : undefined;
  };
}

export function zBetter(aWins: number, aN: number, bWins: number, bN: number): { z: number; p: number } {
  if (!aN || !bN) return { z: 0, p: 1 };
  const pa = aWins / aN, pb = bWins / bN, pp = (aWins + bWins) / (aN + bN);
  const se = Math.sqrt(pp * (1 - pp) * (1 / aN + 1 / bN)) || 1e-9;
  const z = (pb - pa) / se;
  const p = 0.5 * erfc(z / Math.SQRT2);
  return { z, p };
}
function erfc(x: number): number { // Abramowitz–Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x);
  return x >= 0 ? y : 2 - y;
}

export interface Scored { variantId: string; ref: string; status: string; conversations: number; wins: number; usdPerWin: number }
/**
 * Decide from live outcomes. A "win" = conversation resolved by AI or action done with no thumbs-down.
 * Promote when p < 0.05, n ≥ minN on both sides, and cost per win ≤ champion × maxCostRatio.
 */
export function decide(champ: Scored, challengers: Scored[], opts = { minN: 200, alpha: 0.05, maxCostRatio: 1.25 }) {
  const out: { promote?: string; retire: string[] } = { retire: [] };
  for (const c of challengers) {
    if (c.conversations < opts.minN || champ.conversations < opts.minN) continue;
    const { p } = zBetter(champ.wins, champ.conversations, c.wins, c.conversations);
    const cheapEnough = c.usdPerWin <= champ.usdPerWin * opts.maxCostRatio;
    if (p < opts.alpha && cheapEnough && !out.promote) out.promote = c.variantId;
    else if (zBetter(c.wins, c.conversations, champ.wins, champ.conversations).p < opts.alpha || c.conversations > opts.minN * 5) out.retire.push(c.variantId);
  }
  return out;
}

/** Live scores per variant (joins ai_calls.variant_id → conversation outcome + feedback + cost). */
export async function scoreVariants(db: Db, task: string, sinceDays = 14): Promise<Scored[]> {
  const r = await db.execute<Scored & Record<string, unknown>>(sql`
    with conv as (
      select distinct on (c.conversation_id) c.variant_id, c.conversation_id from ai_calls c
      where c.task = ${task} and c.variant_id is not null and c.conversation_id is not null and c.created_at > now() - make_interval(days => ${sinceDays})),
    cost as (select variant_id, sum(cost_micros) as micros from ai_calls where task = ${task} and created_at > now() - make_interval(days => ${sinceDays}) group by 1)
    select v.id as "variantId", v.ref, v.status, count(conv.conversation_id)::int as conversations,
      count(*) filter (where k.outcome in ('resolved_by_ai','action_done') and not exists (select 1 from ai_feedback f where f.conversation_id = k.id and f.rating < 0))::int as wins,
      coalesce(max(cost.micros), 0) / 1e6 / greatest(count(*) filter (where k.outcome in ('resolved_by_ai','action_done')), 1) as "usdPerWin"
    from ai_variants v left join conv on conv.variant_id = v.id left join ai_conversations k on k.id = conv.conversation_id left join cost on cost.variant_id = v.id
    where v.task = ${task} and v.status in ('champion','challenger') group by v.id`);
  return r.rows;
}

export async function applyDecision(db: Db, task: string, d: { promote?: string; retire: string[] }) {
  if (d.promote) {
    await db.update(aiVariants).set({ status: "retired", trafficBp: 0, decidedAt: sql`now()` }).where(and(eq(aiVariants.task, task), eq(aiVariants.status, "champion")));
    await db.update(aiVariants).set({ status: "champion", trafficBp: 10_000, decidedAt: sql`now()` }).where(eq(aiVariants.id, d.promote));
  }
  if (d.retire.length) await db.update(aiVariants).set({ status: "retired", trafficBp: 0, decidedAt: sql`now()` }).where(inArray(aiVariants.id, d.retire));
  if (d.promote || d.retire.length) publish("ai.settings", { kind: "model", task });
}
