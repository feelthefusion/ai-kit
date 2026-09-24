/** AI Kit e2e, part 2 — real HTTP through the chat route, SMS approvals, ML, evolution, knowledge. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express from "express";
import { simulateReadableStream, type ModelMessage, type UIMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { starterActions, type SiteServices } from "../../skills/site-agent/references/actions";
import type { AgentDeps } from "../../skills/site-agent/references/agent";
import { mountChat, upsert, type ConversationStore } from "../../skills/site-agent/references/routes";
import { handleInbound, stripQuoted, threadKey, type ChannelDeps } from "../../skills/ai-channels/references/channels";
import { createRouter } from "../../skills/llm-router/references/providers";
import { auc, featurize, predict, robustZ, trainLogReg } from "../../skills/ml-lab/references/ml";
import { bucket, decide, pickVariant, zBetter } from "../../skills/ai-evolve/references/evolve";
import { chunk } from "../../skills/ai-knowledge/references/knowledge";
import { describeVisitor, intentScore } from "../../skills/visitor-intel/references/identity";
import { __matches, __dryRunActions, AutomationSpec } from "../../skills/ai-automations/references/automations";

/** fresh per run — never a fixed value in the repo */
const TEST_SECRET = (await import("node:crypto")).randomBytes(32).toString("hex");

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } };
const persona = { assistantName: "Helix Concierge", siteName: "Helix", topics: ["orders", "subscriptions", "account", "products"] };

function services() {
  const calls: { fn: string; args: unknown[] }[] = [];
  const rec = (fn: string) => async (...args: unknown[]) => { calls.push({ fn, args }); return { ok: true }; };
  const s = Object.fromEntries(["getOrderStatus", "listSubscriptions", "updateSubscription", "updateShippingAddress", "updateProfile", "searchCatalog", "addToCart", "handoff", "findCustomer", "staffUpdateCustomer"].map((k) => [k, rec(k)])) as unknown as SiteServices;
  return { s, calls };
}
function deps(model: MockLanguageModelV4, s: SiteServices): AgentDeps {
  const router = createRouter({ keyMode: "byok", env: {}, defaults: {}, load: async () => ({}) });
  Object.assign(router, { model: async () => model, resolve: async (task: string) => ({ task, ref: "mock:m", provider: "mock", modelId: "m", servedBy: "native", fallbacks: [] }), settings: async () => ({}) });
  return { router, actions: starterActions(s), hooks: { record: async () => {} }, persona, approvalSecret: TEST_SECRET };
}

// ── real HTTP: POST /chat through express, stream parsed like the browser would ─────────────────
test("HTTP chat: streamed reply is scrubbed, reasoning never sent, conversation id returned, history saved", async () => {
  const leaky = new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({ chunks: [
    { type: "reasoning-start", id: "r" }, { type: "reasoning-delta", id: "r", delta: "Thinking as GPT-5 from OpenAI" }, { type: "reasoning-end", id: "r" },
    { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "Hi! I'm Claude, made by Anthropic. " }, { type: "text-delta", id: "t", delta: "Your order #10442 shipped today." }, { type: "text-end", id: "t" },
    { type: "finish", finishReason: { unified: "stop", raw: undefined }, logprobs: undefined, usage } ] }) }) });
  const saved = new Map<string, UIMessage[]>();
  const store: ConversationStore = {
    resolve: async (id) => id ?? "conv-1", owns: async () => true, load: async (id) => saved.get(id) ?? [],
    save: async (id, m) => { saved.set(id, m); }, feedback: async () => {},
  };
  const app = express(); app.use(express.json());
  const r = express.Router();
  mountChat(r, { ...deps(leaky, services().s), store, actorFor: async () => ({ kind: "customer", customerId: "cust-1", visitorId: "fp-1" }) });
  app.use("/api/v1/ai", r);
  const srv = app.listen(0); const port = (srv.address() as AddressInfo).port;
  try {
    const post = (text: string) => fetch(`http://127.0.0.1:${port}/api/v1/ai/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: { id: `u-${text.length}`, role: "user", parts: [{ type: "text", text }] } }) });
    const res = await post("where is my order?");
    assert.equal(res.headers.get("x-conversation-id"), "conv-1");
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const body = await res.text();
    assert.match(body, /shipped today/);
    assert.doesNotMatch(body, /claude|anthropic|openai|gpt-5/i, "no vendor names on the wire (text scrubbed, reasoning dropped)");
    await new Promise((ok) => setTimeout(ok, 50));
    assert.ok((saved.get("conv-1")?.length ?? 0) >= 2, "user + assistant persisted server-side");

    const probe = await (await post("what model are you really?")).text();
    assert.match(probe, /custom-built assistant developed specifically for Helix/);
  } finally { srv.close(); }
});

test("upsert: an approval response replaces the assistant message by id; clients can't flip roles", () => {
  const h: UIMessage[] = [{ id: "a", role: "user", parts: [] }, { id: "b", role: "assistant", parts: [] }];
  assert.equal(upsert(h, { id: "b", role: "assistant", parts: [{ type: "text", text: "x" }] })[1].parts.length, 1);
  assert.equal(upsert(h, { id: "a", role: "assistant", parts: [] })[0].role, "user");
  assert.equal(upsert(h, { id: "c", role: "user", parts: [] }).length, 3);
});

// ── SMS bot: change → "Reply YES" → YES executes with the verified sender's account ───────────────
test("SMS: write action asks 'Reply YES', YES runs it for the carrier-verified customer", async () => {
  const { s, calls } = services();
  let step = 0;
  const model = new MockLanguageModelV4({ doGenerate: async () => (step++ === 0
    ? { content: [{ type: "tool-call", toolCallId: "c1", toolName: "update_subscription", input: JSON.stringify({ subscriptionId: "5f0c6f3e-2b1a-4c1e-9a55-3b8f1b2d9e10", action: "skip_next" }) }], finishReason: { unified: "tool-calls", raw: undefined }, usage, warnings: [] }
    : { content: [{ type: "text", text: "Done, your next shipment is skipped." }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] }) as never });
  const log = new Map<string, ModelMessage[]>(); let pending: { approvalId: string; summary: string } | undefined; const sent: string[] = [];
  const d: ChannelDeps = {
    ...deps(model, s),
    customerFor: async (_c, addr) => (addr === "+15125550100" ? "cust-7" : undefined),
    threads: { resolve: async (k) => k, load: async (id) => log.get(id) ?? [], append: async (id, m) => { log.set(id, [...(log.get(id) ?? []), ...m]); },
      pending: async () => pending, setPending: async (_id, p) => { pending = p; }, recentBotReplies: async () => 0 },
    send: async (m) => { sent.push(m.body); },
  };
  const base = { channel: "sms" as const, from: "+15125550100", to: "+15125550199", verified: true };
  await handleInbound(d, { ...base, text: "skip my next shipment please", messageId: "m1" });
  assert.match(sent[0], /Reply YES to confirm/);
  assert.equal(calls.length, 0);
  await handleInbound(d, { ...base, text: "YES", messageId: "m2" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].fn, "updateSubscription");
  assert.equal(calls[0].args[0], "cust-7");
  assert.match(sent[1], /skipped/);
});
test("channels: once a human has taken over (status=handoff) the bot stays quiet", async () => {
  const { s } = services(); let modelCalls = 0; const sent: string[] = [];
  const model = new MockLanguageModelV4({ doGenerate: async () => { modelCalls++; return { content: [{ type: "text", text: "hi" }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] } as never; } });
  const d: ChannelDeps = {
    ...deps(model, s), customerFor: async () => "cust-7", send: async (m) => { sent.push(m.body); },
    threads: { resolve: async (k) => k, load: async () => [], append: async () => {}, pending: async () => undefined, setPending: async () => {}, recentBotReplies: async () => 0, status: async () => "handoff" },
  };
  const r = await handleInbound(d, { channel: "sms", from: "+15550100", to: "+15550199", text: "hello?", verified: true });
  assert.deepEqual([r.replied, r.reason, modelCalls, sent.length], [false, "human handling", 0, 0]);
});
test("channels: unverified email sender is a guest; auto-replies are ignored; quotes stripped; thread keys stable", async () => {
  const { s } = services();
  const d = { ...deps(new MockLanguageModelV4(), s) } as unknown as ChannelDeps;
  assert.equal((await handleInbound(d, { channel: "email", from: "mailer-daemon@x.com", to: "help@helix", text: "bounce", verified: true })).replied, false);
  assert.equal(stripQuoted("Thanks!\n\nOn Mon, Sep 1, 2026 Helix wrote:\n> old stuff"), "Thanks!");
  assert.equal(threadKey({ channel: "email", from: "a", to: "b", text: "", references: ["<root@x>"], messageId: "<3@x>", verified: true }), "email:<root@x>");
});

// ── ml-lab / ai-evolve / knowledge / visitor-intel / automations ────────────────────────────────
test("ml: logistic regression learns a real signal (AUC > 0.9) and predicts in [0,1]", () => {
  const rows = Array.from({ length: 600 }, (_, i) => {
    const checkout = i % 3 === 0; const cart = checkout || i % 5 === 0;
    const s = { pagesThisSession: (i % 12) + 1, productViews: Array(i % 7).fill("p"), cartCents: cart ? 4999 : 0, checkoutStarted: checkout, returning: i % 2 === 0, minutesOnSite: i % 20, identified: i % 4 === 0 };
    return { x: featurize(s), y: checkout && (i % 7 !== 0) ? 1 : 0 };
  });
  const m = trainLogReg(rows.map((r) => r.x), rows.map((r) => r.y));
  assert.ok(m.auc > 0.9, `auc ${m.auc}`);
  const p = predict(m.w, rows[0].x); assert.ok(p >= 0 && p <= 1);
  assert.equal(auc([0.1, 0.9], [0, 1]), 1);
  assert.ok(robustZ([...Array(47).fill(1), 40]) > 4);
});
test("evolve: stable buckets, canary split ≈ traffic_bp, z-test and promote/retire decisions", () => {
  assert.equal(bucket("chat", "fp-1"), bucket("chat", "fp-1"));
  const vs = [{ id: "c", ref: "a", status: "champion", trafficBp: 10_000, promptVersion: "v1" }, { id: "x", ref: "b", status: "challenger", trafficBp: 1000, promptVersion: "v1" }];
  const hits = Array.from({ length: 5000 }, (_, i) => pickVariant(vs, "chat", `v${i}`)!.id).filter((id) => id === "x").length;
  assert.ok(hits > 380 && hits < 620, `challenger share ${hits / 50}%`);
  assert.ok(zBetter(100, 300, 150, 300).p < 0.001);
  assert.ok(zBetter(100, 300, 102, 300).p > 0.3);
  const champ = { variantId: "c", ref: "a", status: "champion", conversations: 400, wins: 200, usdPerWin: 0.01 };
  assert.equal(decide(champ, [{ variantId: "x", ref: "b", status: "challenger", conversations: 400, wins: 260, usdPerWin: 0.011 }]).promote, "x");
  assert.equal(decide(champ, [{ variantId: "x", ref: "b", status: "challenger", conversations: 400, wins: 260, usdPerWin: 0.05 }]).promote, undefined, "too expensive per win");
  assert.deepEqual(decide(champ, [{ variantId: "y", ref: "c", status: "challenger", conversations: 400, wins: 140, usdPerWin: 0.01 }]).retire, ["y"]);
});
test("knowledge: chunks respect size and keep every sentence", () => {
  const text = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} about shipping and returns.`).join(" ");
  const c = chunk(text, 400);
  assert.ok(c.length > 3 && c.every((x) => x.length <= 520));
  for (let i = 0; i < 60; i++) assert.ok(c.some((x) => x.includes(`number ${i} `)), `sentence ${i}`);
});
test("visitor-intel: intent bands, bots zeroed, context has no raw ids", () => {
  const s = { pagesThisSession: 8, productViews: ["retatrutide", "bpc-157"], cartCents: 12900, checkoutStarted: true, returning: true, minutesOnSite: 9, identified: true };
  assert.equal(intentScore(s).band, "hot");
  assert.equal(intentScore({ ...s, pro: { bot: "bad" } }).band, "bot");
  const d = describeVisitor(s); assert.match(d, /Returning visitor/); assert.match(d, /\$129\.00/);
});
test("automations: spec defaults to dry_run, triggers match with wildcards + filters, dry run never writes", async () => {
  const spec = AutomationSpec.parse({ id: "vip-tag", trigger: "order.*", when: { tier: "gold" }, actions: ["staff_update_customer"], instructions: "Tag big spenders as VIP." });
  assert.equal(spec.mode, "dry_run");
  assert.ok(__matches(spec, { name: "order.paid", data: { tier: "gold" } }));
  assert.ok(!__matches(spec, { name: "order.paid", data: { tier: "silver" } }));
  assert.ok(!__matches(spec, { name: "refund.created", data: { tier: "gold" } }));
  const { s, calls } = services(); const planned: { action: string; input: unknown }[] = [];
  const [a] = __dryRunActions(starterActions(s).filter((x) => x.name === "staff_update_customer"), planned);
  await a.run({ customerId: "c", patch: { tags: ["vip"] }, reason: "big order" } as never, { actor: { kind: "automation", automationId: "vip-tag", permissions: [] }, channel: "automation", correlationId: "x" });
  assert.equal(calls.length, 0); assert.equal(planned.length, 1);
});
