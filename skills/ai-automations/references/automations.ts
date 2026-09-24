/**
 * ai-automations — AI that works in the background: something happens → an agent with a narrow set
 * of actions decides and acts → every step recorded and streamed live.
 *
 * Spec lives in the repo (automations/<id>.automation.json, reviewed like code) and is mirrored to
 * ai_automations so the admin console can toggle it live. Triggers are bus events:
 *   business events  order.paid, order.delivered, subscription.renewed, payment.failed, review.created…
 *   AI events        ai.action (e.g. update_shipping_address executed), ai.conversation outcomes
 *   schedule         cron.hourly / cron.daily (the app's job runner publishes these)
 *   inbound hooks    POST /api/v1/ai/hooks/:name (live-bus webhooks) → event
 *
 * Gate (optional): one typed yes/no question on the event, answered by the "decide" task (Jev ≈ free,
 * ~100 ms) BEFORE the agent runs — "Does this review describe a damaged or wrong item?" at min 0.7.
 * Below → run recorded as skipped (with P), no model turn spent. No decide model → the run fails
 * visibly: a gated automation never acts without its gate.
 *
 * Guarantees: one run per (automation, event) — unique index, safe on retries/replays.
 * Only the actions listed in the spec exist for that run. mode "dry_run" swaps every write for a
 * recorder, so you see exactly what it WOULD do before flipping it live.
 */
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import { aiAutomationRuns } from "../../ai-kit/references/ai-schema";
import { publish, subscribe, type Envelope } from "../../live-bus/references/bus";
import type { ActionDef } from "../../site-agent/references/actions";
import { prepareTurn, type AgentDeps } from "../../site-agent/references/agent";
import { decide, p as prob } from "../../llm-router/references/decide";

type Db = NodePgDatabase<Record<string, never>>;

export const AutomationSpec = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  trigger: z.string(),                                   // event name; "*" suffix allowed: "order.*"
  when: z.record(z.string(), z.unknown()).optional(),    // shallow equality filter on event data
  mode: z.enum(["live", "dry_run"]).default("dry_run"),
  permissions: z.array(z.string()).default([]),
  actions: z.array(z.string()).min(1),                   // allowed action names (subset of the registry)
  instructions: z.string().min(10),
  maxSteps: z.number().int().min(1).max(20).default(8),
  gate: z.object({ question: z.string().min(8), min: z.number().min(0).max(1).default(0.7) }).optional(),
});
export type AutomationSpec = z.infer<typeof AutomationSpec>;

const matches = (spec: AutomationSpec, e: { name: string; data?: Record<string, unknown> }) =>
  (spec.trigger === e.name || (spec.trigger.endsWith(".*") && e.name.startsWith(spec.trigger.slice(0, -1)))) &&
  Object.entries(spec.when ?? {}).every(([k, v]) => e.data?.[k] === v);

/** Replace writes with recorders for dry runs; reads still run so the plan is realistic. */
function dryRunActions(actions: ActionDef[], planned: { action: string; input: unknown }[]): ActionDef[] {
  return actions.map((a) => (a.mode === "read" ? a : { ...a, run: async (input: unknown) => { planned.push({ action: a.name, input }); return { ok: true, dryRun: true }; } }));
}

export async function runAutomation(db: Db, deps: AgentDeps, spec: AutomationSpec, event: { id: string; name: string; subject?: string; data?: Record<string, unknown> }) {
  const [run] = await db.insert(aiAutomationRuns).values({ automationId: spec.id, eventId: event.id, status: "running" })
    .onConflictDoNothing().returning({ id: aiAutomationRuns.id });
  if (!run) return { skipped: true as const };                 // already ran for this event
  publish("ai.automation", { automationId: spec.id, runId: run.id, status: "running", eventId: event.id });

  if (spec.gate) {
    let pYes: number;
    try {
      const d = await decide(deps.router, {
        purpose: "gate", onCall: deps.onDecision, context: { automationRunId: run.id, channel: "automation" },
        state: { event: event.name, subject: event.subject ?? null, data: (event.data ?? {}) as Record<string, unknown> },
        questions: { gate: { type: "boolean", instructions: spec.gate.question } },
      });
      pYes = prob(d, "gate");
    } catch (e) {
      const error = `gate: ${e instanceof Error ? e.message : String(e)}`;
      await db.update(aiAutomationRuns).set({ status: "failed", error, endedAt: sql`now()` }).where(sql`${aiAutomationRuns.id} = ${run.id}`);
      publish("ai.automation", { automationId: spec.id, runId: run.id, status: "failed", eventId: event.id });
      throw new Error(error);
    }
    if (pYes < spec.gate.min) {
      await db.update(aiAutomationRuns).set({ status: "skipped", output: { gate: { question: spec.gate.question, p: pYes, min: spec.gate.min } }, endedAt: sql`now()` }).where(sql`${aiAutomationRuns.id} = ${run.id}`);
      publish("ai.automation", { automationId: spec.id, runId: run.id, status: "skipped", eventId: event.id });
      return { runId: run.id, skipped: true as const, gate: pYes };
    }
  }

  const planned: { action: string; input: unknown }[] = [];
  const allowed = deps.actions.filter((a) => spec.actions.includes(a.name));
  const actions = spec.mode === "dry_run" ? dryRunActions(allowed, planned) : allowed;
  try {
    const p = await prepareTurn(
      { ...deps, actions, maxSteps: spec.maxSteps, onTurnEnd: async (t) => { await deps.onTurnEnd?.({ ...t, automationRunId: run.id } as never); } },
      { actor: { kind: "automation", automationId: spec.id, permissions: spec.permissions }, channel: "automation", correlationId: `auto:${spec.id}:${event.id}`, text: "" },
    );
    if (p.kind !== "agent") throw new Error("automation turn was guarded");
    const r = await p.agent.generate({ prompt: `${spec.instructions}\n\nEVENT ${event.name} (${event.id})${event.subject ? ` for ${event.subject}` : ""}:\n${JSON.stringify(event.data ?? {}, null, 2)}\n\nDo the job with your tools, then reply with one line: what you did.` });
    const executed = r.steps.reduce((n, s) => n + s.toolResults.length, 0);
    await db.update(aiAutomationRuns).set({ status: spec.mode === "dry_run" ? "dry_run" : "done", actions: executed, output: { summary: r.text, planned }, endedAt: sql`now()` }).where(sql`${aiAutomationRuns.id} = ${run.id}`);
    publish("ai.automation", { automationId: spec.id, runId: run.id, status: spec.mode === "dry_run" ? "dry_run" : "done", eventId: event.id });
    return { runId: run.id, summary: r.text, planned };
  } catch (e) {
    await db.update(aiAutomationRuns).set({ status: "failed", error: e instanceof Error ? e.message : String(e), endedAt: sql`now()` }).where(sql`${aiAutomationRuns.id} = ${run.id}`);
    publish("ai.automation", { automationId: spec.id, runId: run.id, status: "failed", eventId: event.id });
    throw e;
  }
}

/** Start the engine: every bus "event" (and ai.action executions) → matching active automations. */
export function startAutomations(db: Db, deps: AgentDeps, specs: () => Promise<AutomationSpec[]> | AutomationSpec[]) {
  const toEvent = (e: Envelope) =>
    e.topic === "event" ? (e.data as { id: string; name: string; subject?: string; data?: Record<string, unknown> })
    : e.topic === "ai.action" ? { id: `ai.action:${e.id}`, name: `ai.action.${(e.data as { action: string }).action}.${(e.data as { status: string }).status}`, data: e.data as Record<string, unknown> }
    : undefined;
  return subscribe(["event", "ai.action"], async (env) => {
    const ev = toEvent(env);
    if (!ev) return;
    for (const s of await specs()) if (matches(s, ev)) void runAutomation(db, deps, s, ev).catch(() => {});
  });
}

/** For the admin console "Test" button: run one spec against a sample event in dry-run. */
export const preview = (db: Db, deps: AgentDeps, spec: AutomationSpec, sample: { name: string; data?: Record<string, unknown> }) =>
  runAutomation(db, deps, { ...spec, mode: "dry_run" }, { id: `preview:${Date.now()}`, ...sample });

export { matches as __matches, dryRunActions as __dryRunActions };
