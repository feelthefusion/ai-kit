/**
 * llm-router · decide — typed decisions in ONE call: yes/no, pick-one, rubric score, with probabilities.
 *
 *   const d = await decide(router, { purpose: "triage", state: { message }, questions: {
 *     needs_reply: { type: "boolean", instructions: "Is this from a person expecting a reply?" },
 *     team:        { type: "choice",  instructions: "Who should handle it?", criteria: { billing: "…", shipping: "…" } },
 *     urgency:     { type: "score",   instructions: "How urgent?", criteria: ["routine", "soon", "urgent"] },
 *   }});
 *   if (!yes(d, "needs_reply", 0.15)) return;          pick(d, "team", 0.6) → "billing" | undefined
 *
 * The model is the "decide" task (router.evaluation): Jev when reachable — typesafe-ai:jev-1.13.0 (own
 * key, fastest), openrouter:~typesafe/jev-latest (the one OpenRouter key), gateway:typesafe-ai/jev — else
 * an LLM adapter (openai: / anthropic: / google:) answering the same questions. Answers can only be one
 * of the options you defined; they can still be WRONG, so act on `confidence`, not on the pick alone.
 *
 * confidence (0–1): provider-reported when present (Jev reports it for choice/score); else derived
 * from the distribution the TypeSafe way — (n·peak − 1)/(n − 1) — boolean → |2p − 1|; undefined when
 * the adapter returned no distribution (LLM adapters for choice/score). `pick` treats undefined as
 * "no calibration available" and returns the choice (same trust as a plain LLM classifier).
 *
 * Every call reports through `onCall` → ai-analytics recordDecision → ai_calls (task "decide", cost:
 * $0.042/M input, output free on Jev). Never pass `ref` from feature code — ai-evolve owns variants.
 */
import {
  experimental_evaluate as evaluate,
  type Experimental_EvaluationQuestion as Question,
  type Experimental_EvaluationResult as EvaluationResult,
} from "ai";
import { openrouterSlug, type LlmRouter, type ModelRef, type Task } from "./providers";

export type Questions = Record<string, Question>;
/** What the questions are about — a string, a JSON object, or a JSON array (one shared state). */
export type State = string | { readonly [k: string]: unknown } | readonly unknown[];

export interface DecisionTelemetry {
  task: Task; purpose: string;
  ref: string; provider: string; modelId: string; servedBy: "native" | "openrouter"; fallback: boolean;
  /** catalog row to price BYOK calls from (ai_models) */
  priceRef: string;
  inputTokens?: number; outputTokens?: number; latencyMs: number; providerMetadata?: unknown;
  conversationId?: string; channel?: string; visitorId?: string; automationRunId?: string; variantId?: string;
  error?: string;
}

export interface DecideOptions<Q extends Questions> {
  /** what this decision is for — "guard", "triage", "label", "rerank", "gate", "eval" (analytics key) */
  purpose: string;
  state: State;
  questions: Q;
  task?: Task;
  /** ai-evolve variant only */
  ref?: ModelRef;
  abortSignal?: AbortSignal;
  context?: Pick<DecisionTelemetry, "conversationId" | "channel" | "visitorId" | "automationRunId" | "variantId">;
  onCall?: (t: DecisionTelemetry) => void | Promise<void>;
}

export interface Decision<Q extends Questions> {
  answers: EvaluationResult<Q>["answers"];
  confidence: { [K in keyof Q]: number | undefined };
  model: { ref: string; provider: string; modelId: string; servedBy: "native" | "openrouter"; fallback: boolean };
  usage: EvaluationResult<Q>["usage"];
  latencyMs: number;
}

type Meta = { typesafe?: { confidence?: Record<string, number> }; openrouter?: { answers?: Record<string, { confidence?: number }> }; "llm-router"?: { ref?: string; fallback?: boolean } };

export function confidenceOf(answer: { type: string; probability?: number; probabilities?: Record<string, number> }, native?: number): number | undefined {
  if (typeof native === "number") return native;
  if (answer.type === "boolean" && typeof answer.probability === "number") return Math.abs(2 * answer.probability - 1);
  const v = answer.probabilities ? Object.values(answer.probabilities) : [];
  if (v.length < 2) return undefined;
  return Math.max(0, Math.min(1, (v.length * Math.max(...v) - 1) / (v.length - 1)));
}

export async function decide<const Q extends Questions>(router: LlmRouter, o: DecideOptions<Q>): Promise<Decision<Q>> {
  const task = o.task ?? "decide";
  const started = Date.now();
  const model = await router.evaluation(task, o.ref);
  const report = async (ref: string, fallback: boolean, extra: Partial<DecisionTelemetry>) => {
    const r = await router.resolve(task, ref as ModelRef);
    const priceRef = `openrouter:${r.servedBy === "openrouter" ? r.modelId : openrouterSlug(r.provider, r.modelId)}`;
    const t: DecisionTelemetry = { task, purpose: o.purpose, ref, provider: r.provider, modelId: r.modelId, servedBy: r.servedBy, fallback, priceRef, latencyMs: Date.now() - started, ...o.context, ...extra };
    await Promise.resolve(o.onCall?.(t)).catch(() => undefined);
    return t;
  };
  let r: EvaluationResult<Q>;
  try {
    // retries = the fallback chain (router.evaluation), not repeated waits on one provider
    r = await evaluate({ model, state: o.state as never, questions: o.questions, maxRetries: 0, abortSignal: o.abortSignal });
  } catch (e) {
    await report(o.ref ?? (await router.resolve(task)).ref, false, { error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
  const md = (r.providerMetadata ?? {}) as Meta;
  const served = md["llm-router"];
  const t = await report(served?.ref ?? o.ref ?? (await router.resolve(task)).ref, !!served?.fallback, {
    inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, providerMetadata: r.providerMetadata,
  });
  const confidence = Object.fromEntries(Object.keys(o.questions).map((id) => {
    const a = (r.answers as Record<string, { type: string; probability?: number; probabilities?: Record<string, number> }>)[id];
    return [id, confidenceOf(a, md.typesafe?.confidence?.[id] ?? md.openrouter?.answers?.[id]?.confidence)];
  })) as Decision<Q>["confidence"];
  return { answers: r.answers, confidence, model: { ref: t.ref, provider: t.provider, modelId: t.modelId, servedBy: t.servedBy, fallback: t.fallback }, usage: r.usage, latencyMs: t.latencyMs };
}

type Ans = { type: string; probability?: number; choice?: string; score?: number };
const ans = <Q extends Questions>(d: Decision<Q>, id: keyof Q & string) => (d.answers as Record<string, Ans>)[id];

/** boolean question: P(yes) ≥ min */
export const yes = <Q extends Questions>(d: Decision<Q>, id: keyof Q & string, min = 0.5) => (ans(d, id).probability ?? 0) >= min;
/** P(yes) for a boolean question */
export const p = <Q extends Questions>(d: Decision<Q>, id: keyof Q & string) => ans(d, id).probability ?? 0;
/** choice question: the option when confidence ≥ min (or no calibration available), else undefined */
export function pick<Q extends Questions>(d: Decision<Q>, id: keyof Q & string, min = 0.5): string | undefined {
  const c = d.confidence[id];
  return c === undefined || c >= min ? ans(d, id).choice : undefined;
}
/** score question: nearest level index (0 … levels-1) */
export const level = <Q extends Questions>(d: Decision<Q>, id: keyof Q & string) => Math.round(ans(d, id).score ?? 0);
