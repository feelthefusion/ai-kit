/**
 * ai-analytics · telemetry — the ONE writer of AI numbers (ai_calls, ai_feedback, conversation outcomes).
 *
 * Tracks every model call (task, model, served-by, tokens, cost, latency, steps, tool calls, errors),
 * every conversation outcome (resolved by AI / handed off / action done / abandoned), approval
 * acceptance, CSAT/thumbs, and revenue attributed to AI conversations. Streams live over the bus.
 *
 * Cost: OpenRouter reports the exact charge per call (providerMetadata.openrouter.usage.cost, USD) —
 * used when present. BYOK calls are priced from the ai_models catalog (input/output micros per Mtok).
 *
 * Cohesion: site-wide tracking (page views, sessions, funnels, attribution) belongs to marketing-kit's
 * journey-analytics when installed — ONE writer of crm_events. ai-analytics sends it a compact
 * "ai.*" event per turn/outcome through `forward` instead of keeping a second events table.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { aiCalls, aiConversations, aiFeedback, aiModels } from "../../ai-kit/references/ai-schema";
import { publish } from "../../live-bus/references/bus";
import type { TurnTelemetry } from "../../site-agent/references/agent";

type Db = NodePgDatabase<Record<string, never>>;
/** journey-analytics collector (marketing-kit) — `collect(name, props, subject)`; undefined when absent. */
export type Forward = (name: `ai.${string}`, props: Record<string, unknown>, subject: { visitorId?: string; customerId?: string }) => Promise<void> | void;

const priceCache = new Map<string, { at: number; inM: number; outM: number } | null>();

async function pricing(db: Db, ref: string) {
  const hit = priceCache.get(ref);
  if (hit !== undefined && (!hit || Date.now() - hit.at < 3_600_000)) return hit;
  const [m] = await db.select({ inM: aiModels.inputMicrosPerMtok, outM: aiModels.outputMicrosPerMtok }).from(aiModels).where(eq(aiModels.ref, ref)).limit(1);
  const p = m?.inM != null && m?.outM != null ? { at: Date.now(), inM: m.inM, outM: m.outM } : null;
  priceCache.set(ref, p);
  return p;
}

/** Exact provider charge when reported, else catalog price × tokens. Micro-dollars. */
export async function costMicros(db: Db, t: Pick<TurnTelemetry, "ref" | "provider" | "modelId" | "inputTokens" | "outputTokens" | "providerMetadata">): Promise<number | undefined> {
  const or = (t.providerMetadata as { openrouter?: { usage?: { cost?: number } } } | undefined)?.openrouter?.usage?.cost;
  if (typeof or === "number") return Math.round(or * 1e6);
  const p = (await pricing(db, t.ref)) ?? (await pricing(db, `openrouter:${t.provider}/${t.modelId}`));
  if (!p) return undefined;
  return Math.round(((t.inputTokens ?? 0) * p.inM + (t.outputTokens ?? 0) * p.outM) / 1e6);
}

/** Wire as AgentDeps.onTurnEnd (and call from automations / channel bots). */
export function recordTurn(db: Db, forward?: Forward) {
  return async (t: TurnTelemetry & { automationRunId?: string; variantId?: string; error?: string }) => {
    const cost = await costMicros(db, t).catch(() => undefined);
    await db.insert(aiCalls).values({
      task: String(t.task), ref: t.ref, provider: t.provider, modelId: t.modelId, servedBy: t.servedBy,
      conversationId: t.conversationId, automationRunId: t.automationRunId, variantId: t.variantId,
      channel: t.channel, visitorId: t.visitorId, inputTokens: t.inputTokens, outputTokens: t.outputTokens, cachedTokens: t.cachedTokens,
      costMicros: cost, latencyMs: t.latencyMs, steps: t.steps, toolCalls: t.toolCalls, finishReason: t.finishReason, error: t.error,
    });
    if (t.conversationId) await db.update(aiConversations).set({ turns: sql`${aiConversations.turns} + 1`, lastAt: sql`now()` }).where(eq(aiConversations.id, t.conversationId));
    publish("ai.call", { task: String(t.task), costMicros: cost, latencyMs: t.latencyMs, channel: t.channel, error: t.error });
    await forward?.("ai.turn", { task: t.task, channel: t.channel, tool_calls: t.toolCalls, cost_micros: cost, latency_ms: t.latencyMs, verdict: t.verdict }, { visitorId: t.visitorId });
  };
}

export type Outcome = "resolved_by_ai" | "handed_off" | "action_done" | "abandoned";

/** Close the loop on a conversation (resolution detector, handoff, action success, idle timeout job). */
export async function setOutcome(db: Db, conversationId: string, outcome: Outcome, intent?: string, forward?: Forward) {
  const [c] = await db.update(aiConversations).set({ outcome, intent, status: outcome === "handed_off" ? "handoff" : "resolved" })
    .where(eq(aiConversations.id, conversationId)).returning({ visitorId: aiConversations.visitorId, customerId: aiConversations.customerId, channel: aiConversations.channel });
  if (!c) return;
  publish("ai.conversation", { id: conversationId, channel: c.channel, status: outcome });
  await forward?.("ai.conversation.outcome", { outcome, intent, channel: c.channel }, { visitorId: c.visitorId ?? undefined, customerId: c.customerId ?? undefined });
}

/**
 * Attribution: on order.paid, credit the most recent conversation by the same person in the last
 * `windowHours` (default 24). Subscribe to the bus: subscribe(["event"], e => e.data.name === "order.paid" && …).
 */
export async function attributeOrder(db: Db, order: { id: string; customerId?: string; visitorId?: string }, windowHours = 24, forward?: Forward) {
  if (!order.customerId && !order.visitorId) return;
  const who = order.customerId ? eq(aiConversations.customerId, order.customerId) : eq(aiConversations.visitorId, order.visitorId!);
  const [c] = await db.select({ id: aiConversations.id }).from(aiConversations)
    .where(and(who, gte(aiConversations.lastAt, sql`now() - make_interval(hours => ${windowHours})`), sql`${aiConversations.attributedOrderId} is null`))
    .orderBy(sql`${aiConversations.lastAt} desc`).limit(1);
  if (!c) return;
  await db.update(aiConversations).set({ attributedOrderId: order.id }).where(eq(aiConversations.id, c.id));
  await forward?.("ai.order.attributed", { conversation_id: c.id, order_id: order.id }, { customerId: order.customerId, visitorId: order.visitorId });
}

export async function recordFeedback(db: Db, conversationId: string, messageId: string | undefined, rating: number, kind: "thumbs" | "csat", comment?: string) {
  await db.insert(aiFeedback).values({ conversationId, messageId, rating, kind, comment });
  publish("ai.conversation", { id: conversationId, channel: "web", status: `feedback:${kind}:${rating}` });
}
