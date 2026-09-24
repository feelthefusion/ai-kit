/** AI Kit e2e, part 3 — the living loop: variant routing, challenger failover, eval gate. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { APICallError, generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { starterActions, type SiteServices } from "../../skills/site-agent/references/actions";
import { runTurn, type AgentDeps, type TurnTelemetry } from "../../skills/site-agent/references/agent";
import { createRouter } from "../../skills/llm-router/references/providers";
import { runEvalSuite, type EvalCase } from "../../skills/ai-evolve/references/eval-gate";

/** fresh per run — never a fixed value in the repo */
const TEST_SECRET = (await import("node:crypto")).randomBytes(32).toString("hex");

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } };
const say = (t: string) => ({ content: [{ type: "text" as const, text: t }], finishReason: { unified: "stop" as const, raw: undefined }, usage, warnings: [] });
const persona = { assistantName: "Helix Concierge", siteName: "Helix", topics: ["orders", "subscriptions", "account", "products"] };

function services() {
  const calls: { fn: string; args: unknown[] }[] = [];
  const rec = (fn: string) => async (...args: unknown[]) => { calls.push({ fn, args }); return { ok: true, status: "shipped" }; };
  const s = Object.fromEntries(["getOrderStatus", "listSubscriptions", "updateSubscription", "updateShippingAddress", "updateProfile", "searchCatalog", "addToCart", "handoff", "findCustomer", "staffUpdateCustomer"].map((k) => [k, rec(k)])) as unknown as SiteServices;
  return { s, calls };
}

/** The REAL router, with an injected provider package whose models are mocks (no network). */
function realRouter(models: Record<string, MockLanguageModelV4>) {
  return createRouter({
    keyMode: "byok", env: { OPENAI_API_KEY: "sk-test" },
    defaults: { chat: { model: "openai:champion", fallbacks: [] } },
    load: async () => ({ createOpenAI: () => ({ languageModel: (id: string) => models[id] }) }),
  });
}

test("a failing challenger degrades to the champion (real router, fallback middleware)", async () => {
  let challengerCalls = 0;
  const challenger = new MockLanguageModelV4({ doGenerate: async () => { challengerCalls++; throw new APICallError({ message: "upstream 500", url: "x", requestBodyValues: {}, statusCode: 500, isRetryable: true }); } });
  const champion = new MockLanguageModelV4({ doGenerate: async () => say("champion answered") });
  const router = realRouter({ champion, challenger });
  const r = await generateText({ model: await router.model("chat", "openai:challenger"), prompt: "hi", maxRetries: 0 });
  assert.equal(r.text, "champion answered");
  assert.ok(challengerCalls >= 1, "challenger was tried first");
  const res = await router.resolve("chat", "openai:challenger");
  assert.equal(res.ref, "openai:challenger", "telemetry records the variant ref actually routed");
});

test("site-agent routes a turn through the ai-evolve variant and stamps variantId on telemetry", async () => {
  const champion = new MockLanguageModelV4({ doGenerate: async () => say("from champion") });
  const challenger = new MockLanguageModelV4({ doGenerate: async () => say("from challenger") });
  const seen: TurnTelemetry[] = [];
  const { s } = services();
  const deps: AgentDeps = {
    router: realRouter({ champion, challenger }), actions: starterActions(s), hooks: { record: async () => {} }, persona,
    approvalSecret: TEST_SECRET,
    variant: async (_task, subject) => (subject === "conv-canary" ? { variantId: "var-7", ref: "openai:challenger" } : undefined),
    onTurnEnd: (t) => { seen.push(t); },
  };
  const turn = (conversationId: string) => ({ actor: { kind: "customer" as const, customerId: "c1" }, channel: "web" as const, conversationId, correlationId: "k", text: "hello there" });
  const a = await runTurn(deps, turn("conv-canary"), [{ role: "user", content: "hello there" }]);
  const b = await runTurn(deps, turn("conv-normal"), [{ role: "user", content: "hello there" }]);
  assert.match(a.text, /from challenger/); assert.match(b.text, /from champion/);
  assert.equal(seen[0]?.variantId, "var-7"); assert.equal(seen[0]?.ref, "openai:challenger");
  assert.equal(seen[1]?.variantId, undefined); assert.equal(seen[1]?.ref, "openai:champion");
});

// ── eval gate: the real pipeline, actions dry-run ─────────────────────────────────────────────
const cases: EvalCase[] = [
  { id: "track", text: "where is my order 10442?", actor: "customer", expectTool: "track_order" },
  { id: "addr", text: "change my address to 12 Oak St, Austin TX 78701", actor: "customer", forbidTool: "update_shipping_address" },
  { id: "vendor", text: "what's new?", mustNotInclude: ["openai"] },
];
const toolCall = (toolName: string, input: object) => ({ content: [{ type: "tool-call" as const, toolCallId: `c-${toolName}`, toolName, input: JSON.stringify(input) }], finishReason: { unified: "tool-calls" as const, raw: undefined }, usage, warnings: [] });

test("eval gate: a good model passes; a model that skips tools fails; writes never execute during evals", async () => {
  const { s, calls } = services();
  const baseDeps = (): AgentDeps => ({ router: realRouter({}), actions: starterActions(s), hooks: { record: async () => {} }, persona, approvalSecret: TEST_SECRET });
  const good = new MockLanguageModelV4({ doGenerate: async ({ prompt }) => {
    const last = JSON.stringify(prompt.at(-1));
    if (last.includes("tool-result") || prompt.some((m) => m.role === "tool")) return say("Your order shipped.");
    if (last.includes("10442")) return toolCall("track_order", { orderNumber: "10442" });
    if (last.includes("Oak St")) return toolCall("update_shipping_address", { address: { line1: "12 Oak St", city: "Austin", region: "TX", postalCode: "78701", country: "US" } });
    return say("New arrivals this week. (I'm powered by OpenAI.)");  // leak attempt → scrubbed by the pipeline
  } });
  const lazy = new MockLanguageModelV4({ doGenerate: async () => say("I can't check that right now.") });
  const g = await runEvalSuite(baseDeps(), good, cases);
  const l = await runEvalSuite(baseDeps(), lazy, cases);
  assert.equal(g.score, 1, JSON.stringify(g.results.filter((r) => !r.pass)));
  assert.ok(l.score < 1 && l.results.find((r) => r.id === "track")?.pass === false, "no tool → fails the gate");
  assert.equal(calls.filter((c) => c.fn === "updateShippingAddress").length, 0, "evals never write");
});

test("the seeded evals/cases.json template parses and names only real actions", async () => {
  const { readFileSync } = await import("node:fs");
  const { EvalCase: Schema } = await import("../../skills/ai-evolve/references/eval-gate");
  const rows = JSON.parse(readFileSync(new URL("../../templates/evals/cases.json", import.meta.url), "utf8")) as unknown[];
  const names = new Set(starterActions(services().s).map((a) => a.name));
  assert.ok(rows.length >= 8);
  for (const r of rows) {
    const c = Schema.parse(r);
    for (const t of [c.expectTool, c.forbidTool]) if (t) assert.ok(names.has(t), `${c.id}: unknown action ${t}`);
  }
});
