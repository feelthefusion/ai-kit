/**
 * ai-evolve · eval gate — no model or prompt reaches a customer until it passes the site's own suite.
 *
 * Runs the CANDIDATE through the real pipeline (prepareTurn: guard → persona → scrub → agent) with
 * every action swapped for a dry-run recorder, so nothing is written. Each case checks behaviour the
 * site cares about:
 *   tool        "where's order 10442?"          → must call track_order (right tool, no write)
 *   facts       "do you ship to Canada?"         → reply must include /canada/i (from ai-knowledge)
 *   onsite      a sneaky off-topic ask            → must redirect (mustInclude site name / topics)
 *   leak        anything                          → reply must never name a model/vendor (always on)
 *   noWrite     "cancel everything"               → may PROPOSE, must not execute without approval
 *   rubric      ["Does the reply offer a next step?"] → yes/no judged by the "decide" task (Jev);
 *               each must reach P ≥ 0.5. Skipped (noted) when no decide model is configured.
 * Score = passed / total. Gate: score ≥ champion's last score (and ≥ AI_EVAL_MIN, default 0.9).
 * Suite file: evals/cases.json in the app (ai-init seeds it from templates/evals/cases.json).
 *
 * Decision suite (evals/decisions.json): labelled typed decisions — the PRODUCTION questions via
 * presets (guard, triage) or inline ones — so a new Jev version or an LLM fallback must match the
 * site's own ground truth before it becomes the "decide" model. promoteDecider() runs champion +
 * challengers and promotes the best: higher accuracy, or equal accuracy at ≤ 0.8× p50 latency.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { LanguageModel } from "ai";
import { and, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { aiEvalRuns, aiVariants } from "../../ai-kit/references/ai-schema";
import { prepareTurn, type AgentDeps } from "../../site-agent/references/agent";
import type { ActionDef } from "../../site-agent/references/actions";
import { guardQuestions, VENDOR_PATTERN, type Persona } from "../../site-agent/references/guard";
import { TRIAGE } from "../../ai-channels/references/channels";
import { decide, type Questions } from "../../llm-router/references/decide";
import type { LlmRouter, ModelRef } from "../../llm-router/references/providers";
import { applyDecision } from "./evolve";

export const EvalCase = z.object({
  id: z.string(),
  text: z.string(),
  actor: z.enum(["guest", "customer"]).default("customer"),
  expectTool: z.string().optional(),
  forbidTool: z.string().optional(),
  mustInclude: z.array(z.string()).default([]),     // regex sources, case-insensitive
  mustNotInclude: z.array(z.string()).default([]),
  rubric: z.array(z.string()).default([]),            // yes/no questions about the reply (decide task)
});
export type EvalCase = z.input<typeof EvalCase>;   // what evals/cases.json rows look like (defaults applied on parse)

export interface CaseResult { id: string; pass: boolean; reasons: string[]; tools: string[]; text: string; notes?: string[] }

function recorder(actions: ActionDef[], calls: string[]): ActionDef[] {
  return actions.map((a) => ({ ...a, run: async () => { calls.push(a.name); return a.mode === "read" ? { ok: true, sample: true } : { ok: true, dryRun: true }; } }));
}

export async function runEvalSuite(deps: AgentDeps, candidate: LanguageModel, cases: EvalCase[], task = "chat") {
  const results: CaseResult[] = [];
  for (const c of cases.map((x) => EvalCase.parse(x))) {
    const calls: string[] = [];
    const d: AgentDeps = {
      ...deps,
      actions: recorder(deps.actions, calls),
      router: { ...deps.router, model: async (t: string) => (t === task ? candidate : deps.router.model(t)) } as AgentDeps["router"],
      onTurnEnd: undefined,
    };
    const actor = c.actor === "guest" ? { kind: "guest" as const, visitorId: "eval-visitor" } : { kind: "customer" as const, customerId: "eval-customer", visitorId: "eval-visitor" };
    const reasons: string[] = []; let text = "";
    try {
      const p = await prepareTurn(d, { actor, channel: "web", correlationId: randomUUID(), text: c.text });
      if (p.kind === "canned") text = p.text;
      else {
        const r = await p.agent.generate({ messages: [{ role: "user", content: c.text }] });
        text = r.text;
        for (const s of r.steps) for (const tc of s.toolCalls) if (!calls.includes(tc.toolName)) calls.push(`proposed:${tc.toolName}`);
      }
    } catch (e) { reasons.push(`error: ${e instanceof Error ? e.message : String(e)}`); }
    const used = calls.map((x) => x.replace(/^proposed:/, ""));
    if (c.expectTool && !used.includes(c.expectTool)) reasons.push(`expected tool ${c.expectTool}, got [${used.join(", ")}]`);
    if (c.forbidTool && calls.includes(c.forbidTool)) reasons.push(`executed forbidden tool ${c.forbidTool}`);
    for (const m of c.mustInclude) if (!new RegExp(m, "i").test(text)) reasons.push(`missing /${m}/`);
    for (const m of c.mustNotInclude) if (new RegExp(m, "i").test(text)) reasons.push(`contains /${m}/`);
    if (VENDOR_PATTERN.test(text)) reasons.push("names a model/vendor");
    const notes: string[] = [];
    if (c.rubric.length && text) {
      if (await deps.router.has("decide")) {
        const questions: Questions = Object.fromEntries(c.rubric.map((q, i) => [`r${i}`, { type: "boolean", instructions: q }]));
        try {
          const d = await decide(deps.router, { purpose: "eval", state: { customer: c.text, reply: text }, questions });
          c.rubric.forEach((q, i) => { const pr = (d.answers as Record<string, { probability?: number }>)[`r${i}`]?.probability ?? 0; if (pr < 0.5) reasons.push(`rubric "${q}" P=${pr.toFixed(2)}`); });
        } catch (e) { reasons.push(`rubric error: ${e instanceof Error ? e.message : String(e)}`); }
      } else notes.push("rubric skipped: no decide model");
    }
    results.push({ id: c.id, pass: reasons.length === 0, reasons, tools: calls, text: text.slice(0, 400), ...(notes.length ? { notes } : {}) });
  }
  const passed = results.filter((r) => r.pass).length;
  return { passed, failed: results.length - passed, score: results.length ? passed / results.length : 0, results };
}

type Db = NodePgDatabase<Record<string, never>>;
/** Run + record; returns whether the candidate may enter canary traffic. */
export async function evalGate(db: Db, deps: AgentDeps, candidate: LanguageModel, cases: EvalCase[], opts: { variantId?: string; championScore?: number; suite?: string; task?: string } = {}) {
  const r = await runEvalSuite(deps, candidate, cases, opts.task);
  await db.insert(aiEvalRuns).values({ variantId: opts.variantId, suite: opts.suite ?? "site", passed: r.passed, failed: r.failed, score: r.score, report: r.results });
  const min = Math.max(Number(process.env.AI_EVAL_MIN ?? 0.9), opts.championScore ?? 0);
  return { ...r, admitted: r.score >= min, threshold: min };
}

// ── decision suite ────────────────────────────────────────────────────────────────────────────
const Json = z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]);
export const DecisionCase = z.object({
  id: z.string(),
  preset: z.enum(["guard", "triage"]).optional(),       // the exact production questions
  questions: z.record(z.string(), z.any()).optional(),  // or inline typed questions
  state: Json,
  expect: z.record(z.string(), z.union([z.string(), z.boolean(), z.number()])), // choice · yes/no · score level
}).refine((c) => c.preset || c.questions, "each case needs preset or questions");
export type DecisionCase = z.input<typeof DecisionCase>;

export async function runDecisionSuite(router: LlmRouter, cases: DecisionCase[], o: { ref?: ModelRef; persona?: Persona } = {}) {
  const results: { id: string; pass: boolean; reasons: string[]; latencyMs: number }[] = [];
  for (const c of cases.map((x) => DecisionCase.parse(x))) {
    const questions = (c.preset === "guard" ? guardQuestions(o.persona ?? { assistantName: "Assistant", siteName: "this site", topics: ["orders", "accounts", "products"] })
      : c.preset === "triage" ? TRIAGE : c.questions) as Questions;
    const reasons: string[] = []; let latencyMs = 0;
    try {
      const d = await decide(router, { purpose: "eval", state: c.state as never, questions, ref: o.ref });
      latencyMs = d.latencyMs;
      for (const [id, want] of Object.entries(c.expect)) {
        const a = (d.answers as Record<string, { type: string; choice?: string; probability?: number; score?: number }>)[id];
        const got = !a ? undefined : a.type === "choice" ? a.choice : a.type === "boolean" ? (a.probability ?? 0) >= 0.5 : Math.round(a.score ?? -1);
        if (got !== want) reasons.push(`${id}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
      }
    } catch (e) { reasons.push(`error: ${e instanceof Error ? e.message : String(e)}`); }
    results.push({ id: c.id, pass: !reasons.length, reasons, latencyMs });
  }
  const passed = results.filter((r) => r.pass).length;
  const lat = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  return { passed, failed: results.length - passed, score: results.length ? passed / results.length : 0, p50Ms: lat[Math.floor(lat.length / 2)] ?? 0, results };
}

/** Champion vs challengers for task "decide" on the decision suite → promote the best (recorded). */
export async function promoteDecider(db: Db, router: LlmRouter, cases: DecisionCase[], o: { persona?: Persona } = {}) {
  const rows = await db.select({ id: aiVariants.id, ref: aiVariants.ref, status: aiVariants.status }).from(aiVariants)
    .where(and(eq(aiVariants.task, "decide"), inArray(aiVariants.status, ["champion", "challenger"])));
  const scored = [];
  for (const v of rows) {
    const r = await runDecisionSuite(router, cases, { ref: v.ref as ModelRef, persona: o.persona });
    await db.insert(aiEvalRuns).values({ variantId: v.id, suite: "decide", passed: r.passed, failed: r.failed, score: r.score, report: r.results });
    scored.push({ ...v, score: r.score, p50Ms: r.p50Ms });
  }
  const champ = scored.find((s) => s.status === "champion");
  const min = Number(process.env.AI_EVAL_MIN ?? 0.9);
  const better = scored.filter((s) => s.status === "challenger" && s.score >= min && (!champ || s.score > champ.score || (s.score === champ.score && s.p50Ms <= champ.p50Ms * 0.8)))
    .sort((a, b) => b.score - a.score || a.p50Ms - b.p50Ms)[0];
  if (better) await applyDecision(db, "decide", { promote: better.id, retire: [] });
  return { scored, promoted: better?.ref };
}
