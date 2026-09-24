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
 * Score = passed / total. Gate: score ≥ champion's last score (and ≥ AI_EVAL_MIN, default 0.9).
 * Suite file: evals/cases.json in the app (ai-init seeds it from templates/evals/cases.json).
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { LanguageModel } from "ai";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { aiEvalRuns } from "../../ai-kit/references/ai-schema";
import { prepareTurn, type AgentDeps } from "../../site-agent/references/agent";
import type { ActionDef } from "../../site-agent/references/actions";
import { VENDOR_PATTERN } from "../../site-agent/references/guard";

export const EvalCase = z.object({
  id: z.string(),
  text: z.string(),
  actor: z.enum(["guest", "customer"]).default("customer"),
  expectTool: z.string().optional(),
  forbidTool: z.string().optional(),
  mustInclude: z.array(z.string()).default([]),     // regex sources, case-insensitive
  mustNotInclude: z.array(z.string()).default([]),
});
export type EvalCase = z.input<typeof EvalCase>;   // what evals/cases.json rows look like (defaults applied on parse)

export interface CaseResult { id: string; pass: boolean; reasons: string[]; tools: string[]; text: string }

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
    results.push({ id: c.id, pass: reasons.length === 0, reasons, tools: calls, text: text.slice(0, 400) });
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
