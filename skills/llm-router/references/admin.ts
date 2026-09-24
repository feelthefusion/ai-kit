/**
 * llm-router · admin — the "AI console" API. Add any provider key (encrypted at rest), pick the
 * model for every task from the live catalog, test it, watch everything live.
 *
 *   GET    /api/v1/admin/ai/providers          catalog + which have keys (last4 only, never the key)
 *   PUT    /api/v1/admin/ai/providers/:id      { credentials: { ANTHROPIC_API_KEY: "…" } }  → encrypted
 *   DELETE /api/v1/admin/ai/providers/:id
 *   GET    /api/v1/admin/ai/models?q=&tools=1  live catalog (ai_models) for the pickers
 *   GET    /api/v1/admin/ai/tasks              task → model/fallbacks (DB setting or repo default)
 *   PUT    /api/v1/admin/ai/tasks/:task        { model, fallbacks?, temperature?, maxOutputTokens? }
 *   POST   /api/v1/admin/ai/test               { model } → tiny call: latency, tokens, ok
 *   GET    /api/v1/admin/ai/live               SSE: calls, conversations, actions, automations, visitors, model news
 *
 * Mount behind the app's staff auth with a permission like "ai:admin". Keys: AES-256-GCM with
 * AI_KEYS_SECRET (32 random bytes, base64) — `ai-settings secret` prints a fresh one.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Router } from "express";
import { generateText } from "ai";
import { and, eq, ilike, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { aiModelSettings, aiModels, aiProviderKeys } from "../../ai-kit/references/ai-schema";
import { openSse } from "../../live-bus/references/sse";
import { publish } from "../../live-bus/references/bus";
import { PROVIDERS, createRouter, type LlmRouter, type ModelRef, type RouterSources } from "./providers";

type Db = NodePgDatabase<Record<string, never>>;

function secretKey(env = process.env): Buffer {
  const k = Buffer.from(env.AI_KEYS_SECRET ?? "", "base64");
  if (k.length !== 32) throw new Error("AI_KEYS_SECRET must be 32 bytes base64 — run: ai-settings secret");
  return k;
}
export function seal(obj: Record<string, string>) {
  const iv = randomBytes(12); const c = createCipheriv("aes-256-gcm", secretKey(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return { ciphertext: ct.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64") };
}
export function open(row: { ciphertext: string; iv: string; tag: string }): Record<string, string> {
  const d = createDecipheriv("aes-256-gcm", secretKey(), Buffer.from(row.iv, "base64"));
  d.setAuthTag(Buffer.from(row.tag, "base64"));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(row.ciphertext, "base64")), d.final()]).toString("utf8"));
}

/** RouterSources backed by the DB — pass to createRouter() at boot. */
export function dbSources(db: Db, defaults: RouterSources["defaults"], extra: Partial<RouterSources> = {}): RouterSources {
  return {
    defaults, ...extra,
    taskSetting: async (task) => {
      const [r] = await db.select().from(aiModelSettings).where(eq(aiModelSettings.task, String(task))).limit(1);
      return r ? { model: r.model as ModelRef, fallbacks: r.fallbacks as ModelRef[], temperature: r.temperature ?? undefined, maxOutputTokens: r.maxOutputTokens ?? undefined } : undefined;
    },
    providerKey: async (id) => {
      const [r] = await db.select().from(aiProviderKeys).where(eq(aiProviderKeys.providerId, id)).limit(1);
      return r ? open(r) : undefined;
    },
  };
}

export function mountAiAdmin(r: Router, db: Db, router: LlmRouter, defaults: RouterSources["defaults"], staffId: (req: unknown) => string | undefined) {
  r.get("/providers", async (_req, res) => {
    const keys = await db.select({ id: aiProviderKeys.providerId, last4: aiProviderKeys.last4, updatedAt: aiProviderKeys.updatedAt }).from(aiProviderKeys);
    const byId = new Map(keys.map((k) => [k.id, k]));
    res.json({ keyMode: router.mode, providers: await Promise.all(PROVIDERS.map(async (p) => ({ id: p.id, name: p.name, env: p.env, gateway: !!p.gateway, keyless: !!p.keyless, stored: byId.get(p.id) ?? null, usable: await router.usable(p.id) }))) });
  });
  r.put("/providers/:id", async (req, res) => {
    const p = PROVIDERS.find((x) => x.id === req.params.id);
    const creds = (req.body?.credentials ?? {}) as Record<string, string>;
    if (!p || !Object.values(creds).some(Boolean)) return res.status(400).json({ error: "provider + credentials required" });
    const first = String(creds[p.env[0]] ?? Object.values(creds)[0]);
    await db.insert(aiProviderKeys).values({ providerId: p.id, ...seal(creds), last4: first.slice(-4), updatedBy: staffId(req) })
      .onConflictDoUpdate({ target: aiProviderKeys.providerId, set: { ...seal(creds), last4: first.slice(-4), updatedAt: sql`now()` } });
    router.invalidate(); publish("ai.settings", { kind: "key" });
    res.status(204).end();
  });
  r.delete("/providers/:id", async (req, res) => {
    await db.delete(aiProviderKeys).where(eq(aiProviderKeys.providerId, req.params.id));
    router.invalidate(); publish("ai.settings", { kind: "key" });
    res.status(204).end();
  });
  r.get("/models", async (req, res) => {
    const q = String(req.query.q ?? ""); const tools = req.query.tools === "1";
    const rows = await db.select().from(aiModels).where(and(isNull(aiModels.retiredAt), q ? ilike(aiModels.modelId, `%${q}%`) : undefined, tools ? eq(aiModels.tools, true) : undefined)).orderBy(sql`${aiModels.firstSeenAt} desc`).limit(300);
    res.json({ models: rows });
  });
  r.get("/tasks", async (_req, res) => {
    const rows = await db.select().from(aiModelSettings);
    const set = new Map(rows.map((x) => [x.task, x]));
    res.json({ tasks: Object.keys({ ...defaults, ...Object.fromEntries(rows.map((x) => [x.task, 1])) }).map((t) => ({ task: t, setting: set.get(t) ?? null, default: defaults[t] ?? null })) });
  });
  r.put("/tasks/:task", async (req, res) => {
    const { model, fallbacks = [], temperature, maxOutputTokens } = req.body ?? {};
    if (typeof model !== "string" || !model.includes(":")) return res.status(400).json({ error: "model must be <provider>:<model>" });
    await db.insert(aiModelSettings).values({ task: req.params.task, model, fallbacks, temperature, maxOutputTokens, updatedBy: staffId(req) })
      .onConflictDoUpdate({ target: aiModelSettings.task, set: { model, fallbacks, temperature, maxOutputTokens, updatedAt: sql`now()` } });
    router.invalidate(); publish("ai.settings", { kind: "model", task: req.params.task });
    res.status(204).end();
  });
  r.post("/test", async (req, res) => {
    const model = String(req.body?.model ?? "");
    const probe = createRouter({ ...dbSources(db, { test: { model: model as ModelRef } }), taskSetting: undefined });
    const t0 = Date.now();
    try {
      const out = await generateText({ model: await probe.model("test"), prompt: "Reply with the single word: ready", maxOutputTokens: 10, maxRetries: 0 });
      res.json({ ok: true, ms: Date.now() - t0, text: out.text, usage: out.usage, resolved: await probe.resolve("test") });
    } catch (e) { res.json({ ok: false, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) }); }
  });
  r.get("/live", (req, res) => { openSse(req, res, { topics: ["ai.call", "ai.conversation", "ai.action", "ai.automation", "ai.models", "ai.settings", "visitor"] }); });
}
