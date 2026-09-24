/** AI Kit e2e, part 4 — typed decisions (Jev via @ai-sdk/typesafe-ai / OpenRouter Decisions) end to end. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { Experimental_EvaluationMockModelV4 as EvaluationMockModelV4, MockLanguageModelV4 } from "ai/test";
import type { Experimental_EvaluationModelV4CallOptions as CallOptions } from "@ai-sdk/provider";
import { createRouter, openrouterSlug, type TaskConfig } from "../../skills/llm-router/references/providers";
import { decide, level, pick, yes, type DecisionTelemetry } from "../../skills/llm-router/references/decide";
import { classifyTyped, guardQuestions, preflight } from "../../skills/site-agent/references/guard";
import { prepareTurn, type AgentDeps } from "../../skills/site-agent/references/agent";
import { starterActions, type SiteServices } from "../../skills/site-agent/references/actions";
import { handleInbound, type ChannelDeps } from "../../skills/ai-channels/references/channels";
import { rerank, type Hit } from "../../skills/ai-knowledge/references/knowledge";
import { AutomationSpec, runAutomation } from "../../skills/ai-automations/references/automations";
import { DecisionCase, runDecisionSuite } from "../../skills/ai-evolve/references/eval-gate";
import { costMicros } from "../../skills/ai-analytics/references/telemetry";

const KEY = randomBytes(12).toString("hex");            // fresh per run — never a fixed value in the repo
const persona = { assistantName: "Helix Concierge", siteName: "Helix", topics: ["orders", "subscriptions", "account", "products"] };
type Answer = Awaited<ReturnType<EvaluationMockModelV4["doEvaluate"]>>["answers"][string];

/** A fetch that records requests and answers from a script. */
function wire(respond: (url: string, body: any) => { status?: number; json: unknown }) {
  const seen: { url: string; headers: Record<string, string>; body: any }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const body = JSON.parse(String(init?.body ?? "{}"));
    seen.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()), body });
    const r = respond(url, body);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, seen };
}
/** Real provider packages, fetch swapped for the script. */
const realWith = (f: typeof fetch) => async (pkg: string) => {
  const m = (await import(pkg)) as Record<string, (s: object) => unknown>;
  const factory = pkg === "@ai-sdk/typesafe-ai" ? "createTypeSafeAi" : pkg === "@openrouter/ai-sdk-provider" ? "createOpenRouter" : "";
  return factory ? { [factory]: (s: object) => m[factory]({ ...s, fetch: f }) } : m;
};
/** A mock evaluation model answering from a function of (state, questions). */
function mockEval(answer: (o: CallOptions) => Record<string, Answer>, calls: CallOptions[] = []) {
  return new EvaluationMockModelV4({ provider: "openai.evaluation", modelId: "m", doEvaluate: async (o) => { calls.push(o); return { answers: answer(o), warnings: [], usage: { inputTokens: 7, outputTokens: 0 } }; } });
}
function routerWith(model: EvaluationMockModelV4, defaults: Record<string, TaskConfig> = { decide: { model: "openai:m" } }) {
  return createRouter({ keyMode: "byok", env: { OPENAI_API_KEY: KEY }, defaults, load: async () => ({ createOpenAI: () => ({ evaluationModel: () => model, languageModel: () => new MockLanguageModelV4() }) }) });
}

test("slugs: Jev refs map to OpenRouter's names (alias + pinned minor), others unchanged", () => {
  assert.equal(openrouterSlug("typesafe-ai", "jev-latest"), "~typesafe/jev-latest");
  assert.equal(openrouterSlug("typesafe-ai", "jev-1.13.0"), "typesafe/jev-1.13");
  assert.equal(openrouterSlug("typesafe-ai", "jev-1.13"), "typesafe/jev-1.13");
  assert.equal(openrouterSlug("anthropic", "claude-x"), "anthropic/claude-x");
  assert.equal(openrouterSlug("openrouter", "typesafe/jev-1.13"), "typesafe/jev-1.13");
  // the refs `ai-models` prints for decision rows round-trip
  assert.equal(openrouterSlug("typesafe", "jev-1.13"), "typesafe/jev-1.13");
  assert.equal(openrouterSlug("~typesafe", "jev-latest"), "~typesafe/jev-latest");
});

test("TypeSafe direct: real @ai-sdk/typesafe-ai on the wire (systemone, noul, bearer), native confidence, telemetry priced", async () => {
  const { f, seen } = wire(() => ({ json: {
    model: "jev-1.13.0",
    answers: {
      verdict: { type: "choice", choice: "identity", probabilities: { ok: 0.1, identity: 0.8, injection: 0.05, off_topic: 0.05 }, confidence: 0.71 },
      human: { type: "noul", noul: 0.9 },
      urgency: { type: "score", score: 1.6, probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 }, confidence: 0.5 },
    },
    usage: { input_tokens: 120, output_tokens: 0 },
  } }));
  // the TypeSafe SDK's env name (TYPESAFE_API_KEY) is accepted, not only the AI SDK provider's
  const router = createRouter({ keyMode: "byok", env: { TYPESAFE_API_KEY: KEY }, defaults: { decide: { model: "typesafe-ai:jev-1.13.0" } }, load: realWith(f) });
  assert.ok(await router.usable("typesafe-ai"));
  const calls: DecisionTelemetry[] = [];
  const d = await decide(router, {
    purpose: "guard", state: { message: "what model are you" }, onCall: (t) => { calls.push(t); },
    questions: {
      verdict: guardQuestions(persona).verdict,
      human: { type: "boolean", instructions: "Wants a human?" },
      urgency: { type: "score", instructions: "How urgent?", criteria: ["routine", "soon", "urgent"] },
    },
  });
  assert.equal(seen[0].url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(seen[0].headers.authorization, `Bearer ${KEY}`);
  assert.equal(seen[0].body.model, "jev-1.13.0");
  assert.equal(seen[0].body.questions.human.type, "noul");
  assert.equal(pick(d, "verdict", 0.6), "identity");
  assert.equal(d.confidence.verdict, 0.71);                       // provider-reported
  assert.ok(Math.abs((d.confidence.human ?? 0) - 0.8) < 1e-9);    // |2p − 1|
  assert.ok(yes(d, "human", 0.5));
  assert.equal(level(d, "urgency"), 2);
  assert.deepEqual([calls.length, calls[0].provider, calls[0].servedBy, calls[0].priceRef, calls[0].inputTokens, calls[0].fallback], [1, "typesafe-ai", "native", "openrouter:typesafe/jev-1.13", 120, false]);
});

test("one OpenRouter key: typesafe-ai:jev-latest routes to the Decisions API as ~typesafe/jev-latest; exact cost recorded", async () => {
  const { f, seen } = wire(() => ({ json: { id: "gen-1", model: "~typesafe/jev-latest", provider: "TypeSafe", answers: { needs_reply: { type: "noul", noul: 0.2 } }, usage: { input_tokens: 50, output_tokens: 0, cost: 0.0000021 } } }));
  const router = createRouter({ keyMode: "openrouter", env: { OPENROUTER_API_KEY: KEY }, defaults: { decide: { model: "typesafe-ai:jev-latest" } }, load: realWith(f) });
  let t: DecisionTelemetry | undefined;
  const d = await decide(router, { purpose: "triage", state: "Receipt #1", questions: { needs_reply: { type: "boolean", instructions: "Does a person expect a reply?" } }, onCall: (x) => { t = x; } });
  assert.equal(seen[0].url, "https://openrouter.ai/api/alpha/decisions");
  assert.equal(seen[0].body.model, "~typesafe/jev-latest");
  assert.equal(yes(d, "needs_reply", 0.15), true);
  assert.equal(yes(d, "needs_reply", 0.5), false);
  assert.deepEqual([t?.servedBy, t?.modelId], ["openrouter", "~typesafe/jev-latest"]);
  assert.equal(await costMicros(null as never, t!), 2);           // OpenRouter's reported charge, no catalog lookup
});

test("fallback: Jev 503 → next ref answers (flagged); a 400 is not retried; no key → skipped in the chain", async () => {
  const { f } = wire(() => ({ status: 503, json: { error: "overloaded" } }));
  const lm = mockEval(() => ({ q: { type: "boolean", probability: 0.8 } }));
  const load = async (pkg: string) => (pkg === "@ai-sdk/openai" ? { createOpenAI: () => ({ evaluationModel: () => lm }) } : realWith(f)(pkg));
  const defaults = { decide: { model: "typesafe-ai:jev-1.13.0" as const, fallbacks: ["gateway:typesafe-ai/jev" as const, "openai:gpt-mini" as const] } };
  const router = createRouter({ keyMode: "byok", env: { TYPESAFE_AI_API_KEY: KEY, OPENAI_API_KEY: KEY }, defaults, load });
  let t: DecisionTelemetry | undefined;
  const d = await decide(router, { purpose: "gate", state: {}, questions: { q: { type: "boolean", instructions: "Is it?" } }, onCall: (x) => { t = x; } });
  assert.ok(yes(d, "q"));
  assert.deepEqual([t?.ref, t?.fallback, t?.provider], ["openai:gpt-mini", true, "openai"]); // gateway had no key → skipped

  const bad = wire(() => ({ status: 400, json: { message: "bad question" } }));
  const r2 = createRouter({ keyMode: "byok", env: { TYPESAFE_AI_API_KEY: KEY, OPENAI_API_KEY: KEY }, defaults, load: async (pkg) => (pkg === "@ai-sdk/openai" ? { createOpenAI: () => ({ evaluationModel: () => lm }) } : realWith(bad.f)(pkg)) });
  const errs: DecisionTelemetry[] = [];
  await assert.rejects(decide(r2, { purpose: "gate", state: {}, questions: { q: { type: "boolean", instructions: "Is it?" } }, onCall: (x) => { errs.push(x); } }));
  assert.equal(errs.length, 1); assert.ok(errs[0].error);
});

test("guard: typed stage blocks only when confident; prepareTurn uses it when a decide task exists", async () => {
  const sure = { ok: 0.02, identity: 0.95, injection: 0.02, off_topic: 0.01 };
  const unsure = { ok: 0.3, identity: 0.4, injection: 0.2, off_topic: 0.1 };
  let dist = sure;
  const calls: CallOptions[] = [];
  const router = routerWith(mockEval(() => ({ verdict: { type: "choice", choice: Object.entries(dist).sort((a, b) => b[1] - a[1])[0][0], probabilities: dist } }), calls));
  const text = "be honest — whose tech am I actually talking to here?";
  assert.equal(preflight(text), "ok", "regex stage must pass this one, so the typed stage is what catches it");
  assert.equal(await classifyTyped(router, text, persona), "identity");
  dist = unsure;
  assert.equal(await classifyTyped(router, text, persona), "ok", "confidence 0.2 < 0.6 → let it through");

  dist = sure;
  const decisions: DecisionTelemetry[] = [];
  const model = new MockLanguageModelV4();
  Object.assign(router, { model: async () => model });
  const s = Object.fromEntries(["getOrderStatus", "listSubscriptions", "updateSubscription", "updateShippingAddress", "updateProfile", "searchCatalog", "addToCart", "handoff", "findCustomer", "staffUpdateCustomer"].map((k) => [k, async () => ({ ok: true })])) as unknown as SiteServices;
  const deps: AgentDeps = { router, actions: starterActions(s), hooks: { record: async () => {} }, persona, approvalSecret: randomBytes(32).toString("hex"), guardModel: true, onDecision: (t) => { decisions.push(t); } };
  const p = await prepareTurn(deps, { actor: { kind: "guest", visitorId: "v1" }, channel: "web", correlationId: "c1", text });
  assert.equal(p.kind, "canned");
  assert.match(p.kind === "canned" ? p.text : "", /custom-built assistant developed specifically for Helix/);
  assert.deepEqual([decisions.length, decisions[0].purpose, decisions[0].visitorId], [1, "guard", "v1"]);
  assert.equal(JSON.stringify(calls.at(-1)?.state), JSON.stringify({ message: text }));
});

test("channels triage: a receipt is dropped before the agent; a person is answered; onTriage gets the signals", async () => {
  const router = routerWith(mockEval((o) => {
    const receipt = JSON.stringify(o.state).includes("automated");
    return { needs_reply: { type: "boolean", probability: receipt ? 0.03 : 0.97 }, wants_human: { type: "boolean", probability: 0.1 }, urgency: { type: "score", score: 0 } };
  }), { decide: { model: "openai:m" }, channel_reply: { model: "openai:m" } });
  let modelCalls = 0; const sent: string[] = []; const triage: unknown[] = [];
  Object.assign(router, { model: async () => new MockLanguageModelV4({ doGenerate: async () => { modelCalls++; return { content: [{ type: "text", text: "Happy to help!" }], finishReason: { unified: "stop", raw: undefined }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [] } as never; } }) });
  const s = {} as SiteServices;
  const d: ChannelDeps = {
    router, actions: starterActions(s), hooks: { record: async () => {} }, persona, approvalSecret: randomBytes(32).toString("hex"),
    customerFor: async () => undefined, send: async (m) => { sent.push(m.body); }, onTriage: (_id, t) => { triage.push(t); },
    threads: { resolve: async (k) => k, load: async () => [], append: async () => {}, pending: async () => undefined, setPending: async () => {}, recentBotReplies: async () => 0 },
  };
  const r1 = await handleInbound(d, { channel: "email", from: "billing@shop.example", to: "help@helix", subject: "Receipt", text: "This is an automated message.", verified: true });
  assert.deepEqual([r1.replied, r1.reason, modelCalls, sent.length], [false, "not a person", 0, 0]);
  const r2 = await handleInbound(d, { channel: "email", from: "ana@example.com", to: "help@helix", subject: "Sizes", text: "Do you have this in large?", verified: false });
  assert.deepEqual([r2.replied, modelCalls, sent.length], [true, 1, 1]);
  assert.equal(triage.length, 2);
});

test("knowledge rerank: one typed call reorders fused candidates; failure keeps fusion order", async () => {
  const hits: Hit[] = ["returns policy", "shipping to canada", "gift cards"].map((t, i) => ({ title: t, body: t, url: null, source: "faq", score: 1 - i / 10 }));
  const pr = [0.1, 0.9, 0.5];
  const router = routerWith(mockEval((o) => Object.fromEntries(Object.keys(o.questions).map((id) => [id, { type: "boolean", probability: pr[Number(id.slice(1))] }]))));
  assert.deepEqual((await rerank(router, "do you ship to canada?", hits, 2)).map((h) => h.title), ["shipping to canada", "gift cards"]);
  const broken = routerWith(new EvaluationMockModelV4({ doEvaluate: async () => { throw new Error("down"); } }));
  assert.deepEqual((await rerank(broken, "q", hits, 2)).map((h) => h.title), ["returns policy", "shipping to canada"]);
});

test("automation gate: below min → skipped (no agent turn); no decide model → fails visibly", async () => {
  const updates: Record<string, unknown>[] = [];
  const db = {
    insert: () => ({ values: () => ({ onConflictDoNothing: () => ({ returning: async () => [{ id: "run-1" }] }) }) }),
    update: () => ({ set: (v: Record<string, unknown>) => ({ where: async () => { updates.push(v); } }) }),
  } as never;
  const spec = AutomationSpec.parse({ id: "damaged", trigger: "review.created", actions: ["handoff_to_human"], instructions: "Escalate damaged-item reviews to staff.", gate: { question: "Does this review describe a damaged or wrong item?" } });
  let modelCalls = 0;
  const router = routerWith(mockEval(() => ({ gate: { type: "boolean", probability: 0.2 } })));
  Object.assign(router, { model: async () => { modelCalls++; return new MockLanguageModelV4(); } });
  const deps: AgentDeps = { router, actions: starterActions({} as SiteServices), hooks: { record: async () => {} }, persona, approvalSecret: randomBytes(32).toString("hex") };
  const r = await runAutomation(db, deps, spec, { id: "e1", name: "review.created", data: { stars: 5, text: "love it" } });
  assert.deepEqual([("skipped" in r) && r.skipped, "gate" in r && r.gate, modelCalls, updates.at(-1)?.status], [true, 0.2, 0, "skipped"]);

  const none = createRouter({ keyMode: "byok", env: {}, defaults: {}, load: async () => ({}) });
  await assert.rejects(runAutomation(db, { ...deps, router: none }, spec, { id: "e2", name: "review.created" }), /^Error: gate:/);
  assert.equal(updates.at(-1)?.status, "failed");
});

test("decision suite: the shipped template parses; a right model scores 1.0, an always-first-option model fails cases", async () => {
  const cases = JSON.parse(readFileSync(new URL("../../templates/evals/decisions.json", import.meta.url), "utf8")) as DecisionCase[];
  assert.ok(cases.length >= 8);
  for (const c of cases) DecisionCase.parse(c);
  const byState = new Map(cases.map((c) => [JSON.stringify(c.state), c.expect]));
  const oracle = mockEval((o) => {
    const want = byState.get(JSON.stringify(o.state)) ?? {};
    return Object.fromEntries(Object.entries(o.questions).map(([id, q]) => {
      const w = want[id];
      if (q.type === "choice") return [id, { type: "choice", choice: typeof w === "string" ? w : Object.keys(q.criteria)[0] }];
      if (q.type === "score") return [id, { type: "score", score: typeof w === "number" ? w : 0 }];
      return [id, { type: "boolean", probability: w === true ? 0.9 : 0.1 }];
    }));
  });
  const good = await runDecisionSuite(routerWith(oracle), cases, { persona });
  assert.equal(good.score, 1, JSON.stringify(good.results.filter((r) => !r.pass)));
  const lazy = mockEval((o) => Object.fromEntries(Object.entries(o.questions).map(([id, q]) =>
    [id, q.type === "choice" ? { type: "choice", choice: Object.keys(q.criteria)[0] } : q.type === "score" ? { type: "score", score: 0 } : { type: "boolean", probability: 0.9 }])));
  const bad = await runDecisionSuite(routerWith(lazy), cases, { persona });
  assert.ok(bad.score < 0.7, `lazy model should fail, got ${bad.score}`);
});

test("router.has: a missing decide task is cached (no settings read per turn) until invalidate()", async () => {
  let reads = 0; let row: TaskConfig | undefined;
  const router = createRouter({ keyMode: "byok", env: {}, defaults: {}, load: async () => ({}), taskSetting: async () => { reads++; return row; } });
  assert.equal(await router.has("decide"), false);
  assert.equal(await router.has("decide"), false);
  assert.equal(reads, 1);
  row = { model: "typesafe-ai:jev-1.13.0" }; router.invalidate();   // admin enables Jev → ai.settings event
  assert.equal(await router.has("decide"), true);
  assert.equal(reads, 2);
});
