/**
 * ml-lab — machine learning on the site's OWN data, feeding every other owner.
 *
 *   labelConversation()  intent / sentiment / resolved / summary → ai_conversations. With a "decide"
 *                        task: ONE typed decision (Jev) for the labels + confidence per label (train
 *                        only on confident ones), summary on the summarize model. Else: classify task.
 *                        (powers ai-analytics top_intents and ai-evolve's win signal).
 *   trainIntent()        logistic regression on visitor-intel SessionSignals → converted? Pure TS,
 *                        trains in milliseconds on tens of thousands of sessions; weights live in
 *                        ai_predictions ("model:intent_v1") and replace the rule-based intentScore
 *                        only after a HELD-OUT AUC ≥ minAuc (0.7) that beats the stored version.
 *   similarProducts()    nearest neighbours over product embeddings already in ai_knowledge.
 *   robustZ()            robust (median/MAD) z-score for hourly AI spend / volume → alert when > 4.
 * Heavier training (fine-tunes, sentence-transformers, in-browser models) goes through the upstream
 * Hugging Face skills (huggingface-llm-trainer, train-sentence-transformers, transformers-js).
 *
 * Cohesion: churn / CLV / propensity SCORES belong to marketing-kit's growth-optimizer when installed —
 * ml-lab does not write those; it exposes features (intent, sentiment, AI engagement) they can use.
 */
import { generateText, Output } from "ai";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import { aiPredictions } from "../../ai-kit/references/ai-schema";
import type { LlmRouter } from "../../llm-router/references/providers";
import { decide, level, pick, yes, type DecisionTelemetry } from "../../llm-router/references/decide";
import type { SessionSignals } from "../../visitor-intel/references/identity";

type Db = NodePgDatabase<Record<string, never>>;

export const ConversationLabel = z.object({
  intent: z.enum(["order_status", "subscription_change", "address_change", "account_update", "product_question", "purchase_help", "returns_refunds", "billing", "complaint", "handoff_request", "other"]),
  sentiment: z.enum(["positive", "neutral", "negative"]),
  resolved: z.boolean(),
  summary: z.string().max(240),
});

const SENTIMENT = ["negative", "neutral", "positive"] as const;

export async function labelConversation(router: LlmRouter, transcript: string, o: { onCall?: (t: DecisionTelemetry) => void | Promise<void>; conversationId?: string } = {}):
  Promise<z.infer<typeof ConversationLabel> & { confidence?: { intent?: number; sentiment?: number; resolved?: number } }> {
  if (await router.has("decide")) {
    const intents = ConversationLabel.shape.intent.options;
    const d = await decide(router, {
      purpose: "label", state: transcript.slice(-12_000), onCall: o.onCall, context: { conversationId: o.conversationId },
      questions: {
        intent: { type: "choice", instructions: "What did the customer mainly want in this support conversation?", criteria: Object.fromEntries(intents.map((i) => [i, i.replace(/_/g, " ")])) },
        sentiment: { type: "score", instructions: "How did the customer feel by the end of the conversation?", criteria: [...SENTIMENT] },
        resolved: { type: "boolean", instructions: "Was the customer's need met in the conversation?" },
      },
    });
    const { text } = await generateText({
      model: await router.model((await router.has("summarize")) ? "summarize" : "classify"), temperature: 0, maxOutputTokens: 120,
      instructions: "Summarize this support conversation in one sentence (under 240 characters): what the customer wanted and what happened.",
      prompt: transcript.slice(-12_000),
    });
    return {
      intent: (pick(d, "intent", 0) ?? "other") as z.infer<typeof ConversationLabel>["intent"],
      sentiment: SENTIMENT[Math.min(2, Math.max(0, level(d, "sentiment")))], resolved: yes(d, "resolved"),
      summary: text.trim().slice(0, 240), confidence: d.confidence,
    };
  }
  const { output } = await generateText({
    model: await router.model("classify"), temperature: 0,
    output: Output.object({ schema: ConversationLabel }),
    instructions: "Label this support conversation. resolved = the customer's need was met in the conversation.",
    prompt: transcript.slice(-12_000),
  });
  return output;
}

// ── logistic regression (intent_v1) ─────────────────────────────────────────────────────────
export const FEATURES = ["pages", "productViews", "hasCart", "checkout", "returning", "identified", "minutes", "bias"] as const;
export function featurize(s: SessionSignals): number[] {
  return [Math.min(s.pagesThisSession, 20) / 20, Math.min(s.productViews.length, 10) / 10, s.cartCents > 0 ? 1 : 0, s.checkoutStarted ? 1 : 0, s.returning ? 1 : 0, s.identified ? 1 : 0, Math.min(s.minutesOnSite, 30) / 30, 1];
}
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
export const predict = (w: number[], x: number[]) => sigmoid(x.reduce((a, xi, i) => a + xi * w[i], 0));

/** Batch gradient descent with L2. Returns weights + training log-loss + AUC. */
export function trainLogReg(X: number[][], y: number[], opts = { epochs: 400, lr: 0.5, l2: 1e-3 }) {
  const d = X[0]?.length ?? 0; const w = new Array(d).fill(0); const n = X.length;
  for (let e = 0; e < opts.epochs; e++) {
    const g = new Array(d).fill(0);
    for (let i = 0; i < n; i++) { const err = predict(w, X[i]) - y[i]; for (let j = 0; j < d; j++) g[j] += err * X[i][j]; }
    for (let j = 0; j < d; j++) w[j] -= opts.lr * (g[j] / n + (j === d - 1 ? 0 : opts.l2 * w[j]));
  }
  const p = X.map((x) => predict(w, x));
  const logLoss = -p.reduce((a, pi, i) => a + (y[i] ? Math.log(pi + 1e-12) : Math.log(1 - pi + 1e-12)), 0) / n;
  return { w, logLoss, auc: auc(p, y) };
}
export function auc(p: number[], y: number[]): number {
  const pairs = p.map((pi, i) => [pi, y[i]] as const).sort((a, b) => a[0] - b[0]);
  let rank = 0, posRanks = 0, pos = 0;
  for (const [, yi] of pairs) { rank++; if (yi) { posRanks += rank; pos++; } }
  const neg = pairs.length - pos;
  return pos && neg ? (posRanks - (pos * (pos + 1)) / 2) / (pos * neg) : 0.5;
}

/** Nightly: train on labeled sessions, keep the new weights only if AUC ≥ current (never regress). */
export async function trainIntent(db: Db, sessions: { s: SessionSignals; converted: boolean }[], minAuc = 0.7) {
  if (sessions.length < 200) return { skipped: "need ≥200 labeled sessions" };
  // deterministic 80/20 split: AUC is measured on sessions the model never saw
  const train = sessions.filter((_, i) => i % 5 !== 0), test = sessions.filter((_, i) => i % 5 === 0);
  const m = trainLogReg(train.map((r) => featurize(r.s)), train.map((r) => (r.converted ? 1 : 0)));
  const holdout = auc(test.map((r) => predict(m.w, featurize(r.s))), test.map((r) => (r.converted ? 1 : 0)));
  if (holdout < minAuc) return { kept: "rules", auc: holdout, minAuc };
  const [cur] = (await db.execute<{ score: number | null }>(sql`select score from ai_predictions where subject = 'model:intent_v1' and model = 'weights'`)).rows;
  if (cur?.score != null && holdout < cur.score) return { kept: "current", auc: holdout, current: cur.score };
  await db.insert(aiPredictions).values({ subject: "model:intent_v1", model: "weights", value: { w: m.w, features: FEATURES, logLoss: m.logLoss, trainN: train.length, testN: test.length }, score: holdout })
    .onConflictDoUpdate({ target: [aiPredictions.subject, aiPredictions.model], set: { value: sql`excluded.value`, score: sql`excluded.score`, computedAt: sql`now()` } });
  return { trained: true, auc: holdout, n: sessions.length };
}

// ── recommendations + anomalies ──────────────────────────────────────────────────────────────
export async function similarProducts(db: Db, sourceId: string, k = 6) {
  const r = await db.execute<{ source_id: string; title: string | null; d: number }>(sql`
    with me as (select embedding from ai_knowledge where source = 'product' and source_id = ${sourceId} and chunk = 0)
    select k.source_id, k.title, k.embedding <=> (select embedding from me) as d from ai_knowledge k
    where k.source = 'product' and k.chunk = 0 and k.source_id <> ${sourceId} order by d limit ${k}`);
  return r.rows;
}

/** Robust z (median/MAD) of the latest hour vs the prior week. > 4 → alert. */
export function robustZ(series: number[]): number {
  if (series.length < 24) return 0;
  const last = series[series.length - 1]; const prior = series.slice(0, -1).sort((a, b) => a - b);
  const med = prior[Math.floor(prior.length / 2)]; const mad = prior.map((v) => Math.abs(v - med)).sort((a, b) => a - b)[Math.floor(prior.length / 2)] || 1e-9;
  return (last - med) / (1.4826 * mad);
}
