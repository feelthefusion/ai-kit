/**
 * llm-router — ONE engine that turns a task ("chat", "guard", "embed"…) into a model.
 *
 * Key modes (`ai-settings key-mode …`, or AI_KEY_MODE in the app env):
 *   openrouter  one OPENROUTER_API_KEY serves every model ("openrouter:anthropic/claude-…")
 *   byok        each provider's own key; refs are "<provider>:<model>" ("anthropic:claude-…")
 *   mixed       native key when that provider has one, else the same model through OpenRouter
 *
 * Which model a task uses, first match wins:
 *   1. admin console setting (ai_model_settings row, read through `taskSetting`)
 *   2. repo defaults (.agents/ai-models.json, written by `ai-models set`)
 * Keys, first match wins: admin console (ai_provider_keys, decrypted) → process env.
 *
 * Never hard-code a model id in feature code — call `router.model("chat")`. That is what lets the
 * admin swap models live and ai-evolve promote a better one without a deploy.
 * Provider packages load lazily (dynamic import), so the app installs only the ones it uses.
 */
import { APICallError, wrapLanguageModel, type LanguageModel } from "ai";
import type { EmbeddingModelV4, LanguageModelV4, LanguageModelV4Middleware } from "@ai-sdk/provider";
import catalog from "./providers.json" with { type: "json" };

export type KeyMode = "openrouter" | "byok" | "mixed";
export type ModelRef = `${string}:${string}`;
export type Task = keyof typeof catalog.tasks | (string & {});

export interface TaskConfig {
  model: ModelRef;
  fallbacks?: ModelRef[];
  temperature?: number;
  maxOutputTokens?: number;
}

export interface ProviderEntry {
  id: string; name: string; env: string[]; pkg: string; factory: string;
  baseURL?: string; baseURLEnv?: string; models: string | null; auth: string;
  keyless?: boolean; gateway?: boolean;
}

export interface RouterSources {
  keyMode?: KeyMode;
  /** Admin-selected config for a task (DB). undefined → fall through to `defaults`. */
  taskSetting?: (task: Task) => Promise<TaskConfig | undefined>;
  /** Admin-entered credentials for a provider (DB, already decrypted). Wins over env. */
  providerKey?: (providerId: string) => Promise<Record<string, string> | undefined>;
  /** Repo defaults (e.g. shared/ai-config.ts): { chat: { model: "anthropic:…", fallbacks: [...] }, … } */
  defaults: Record<string, TaskConfig>;
  env?: Record<string, string | undefined>;
  /** Applied to every language model, outermost first (identity scrub, telemetry…). */
  middleware?: LanguageModelV4Middleware[];
  /** Load a provider package. Tests inject fakes; default = dynamic import. */
  load?: (pkg: string) => Promise<Record<string, unknown>>;
}

export interface Resolved {
  task: Task; ref: ModelRef; provider: string; modelId: string;
  servedBy: "native" | "openrouter"; fallbacks: ModelRef[];
}

export const PROVIDERS = catalog.providers as ProviderEntry[];
const byId = new Map(PROVIDERS.map((p) => [p.id, p]));
const TTL_MS = 30_000;

export function parseRef(ref: string): { provider: string; modelId: string } {
  const i = ref.indexOf(":");
  if (i < 1) throw new Error(`llm-router: model ref "${ref}" must be "<provider>:<model>" (e.g. openrouter:anthropic/claude-…)`);
  return { provider: ref.slice(0, i), modelId: ref.slice(i + 1) };
}

/** Status codes worth trying the next model for: timeouts, conflicts, rate limits, provider outages. */
export function isRetriable(e: unknown): boolean {
  if (APICallError.isInstance(e)) return e.isRetryable || [408, 409, 429].includes(e.statusCode ?? 0) || (e.statusCode ?? 0) >= 500;
  return e instanceof TypeError; // fetch network failure
}

/** Try the primary; on a retriable failure, the same call goes to each fallback in order. */
export function fallbackMiddleware(fallbacks: LanguageModelV4[]): LanguageModelV4Middleware {
  return {
    specificationVersion: "v4",
    wrapGenerate: async ({ doGenerate, params }) => {
      try { return await doGenerate(); } catch (e) {
        let last = e;
        if (!isRetriable(e)) throw e;
        for (const m of fallbacks) { try { return await m.doGenerate(params); } catch (e2) { last = e2; if (!isRetriable(e2)) throw e2; } }
        throw last;
      }
    },
    wrapStream: async ({ doStream, params }) => {
      try { return await doStream(); } catch (e) {
        let last = e;
        if (!isRetriable(e)) throw e;
        for (const m of fallbacks) { try { return await m.doStream(params); } catch (e2) { last = e2; if (!isRetriable(e2)) throw e2; } }
        throw last;
      }
    },
  };
}

export function createRouter(src: RouterSources) {
  const env = src.env ?? process.env;
  const mode: KeyMode = src.keyMode ?? ((env.AI_KEY_MODE as KeyMode) || (env.OPENROUTER_API_KEY ? "openrouter" : "byok"));
  const load = src.load ?? ((pkg: string) => import(pkg) as Promise<Record<string, unknown>>);
  const providers = new Map<string, Promise<any>>();
  const taskCache = new Map<string, { at: number; cfg: TaskConfig }>();

  async function creds(p: ProviderEntry): Promise<Record<string, string> | undefined> {
    const fromDb = await src.providerKey?.(p.id);
    if (fromDb && Object.values(fromDb).some(Boolean)) return fromDb;
    const out: Record<string, string> = {};
    for (const k of p.env) if (env[k]) out[k] = env[k]!;
    // google accepts either name; one is enough
    if (p.id === "google" && (out.GOOGLE_GENERATIVE_AI_API_KEY || out.GEMINI_API_KEY)) return out;
    if (p.keyless) return out;
    return p.env.every((k) => out[k]) ? out : undefined;
  }

  /** Can this provider serve calls right now (key present / keyless)? */
  async function usable(providerId: string): Promise<boolean> {
    const p = byId.get(providerId);
    return !!p && !!(await creds(p));
  }

  function settingsFor(p: ProviderEntry, c: Record<string, string>): Record<string, unknown> {
    const key = c[p.env[0]] ?? c.GEMINI_API_KEY;
    switch (p.id) {
      case "azure": return { apiKey: c.AZURE_API_KEY, resourceName: c.AZURE_RESOURCE_NAME };
      case "bedrock": return { region: c.AWS_REGION, accessKeyId: c.AWS_ACCESS_KEY_ID, secretAccessKey: c.AWS_SECRET_ACCESS_KEY };
      case "vertex": return { project: c.GOOGLE_VERTEX_PROJECT, location: c.GOOGLE_VERTEX_LOCATION };
      case "openrouter": return { apiKey: key, compatibility: "strict" };
    }
    if (p.factory === "createOpenAICompatible") {
      const baseURL = (p.baseURLEnv && c[p.baseURLEnv]) || p.baseURL;
      return { name: p.id, baseURL, ...(key && p.id !== "ollama" ? { apiKey: key } : {}), includeUsage: true };
    }
    return { apiKey: key };
  }

  async function provider(providerId: string): Promise<any> {
    const p = byId.get(providerId);
    if (!p) throw new Error(`llm-router: unknown provider "${providerId}" — add it to providers.json`);
    const c = await creds(p);
    if (!c) throw new Error(`llm-router: no key for ${p.name} — set ${p.env.join(" + ")} (or add it in the admin AI console)`);
    const cacheKey = `${p.id}:${Object.values(c).join("|").length}:${Object.values(c).join("|").slice(-6)}`;
    if (!providers.has(cacheKey)) {
      providers.set(cacheKey, load(p.pkg).then((mod) => {
        const f = mod[p.factory] as ((s: Record<string, unknown>) => unknown) | undefined;
        if (typeof f !== "function") throw new Error(`llm-router: ${p.pkg} has no ${p.factory}() — check the installed version (ai-doctor)`);
        return f(settingsFor(p, c));
      }).catch((e) => { providers.delete(cacheKey); throw e; }));
    }
    return providers.get(cacheKey)!;
  }

  /** Which provider actually serves a ref under the current key mode. */
  async function route(ref: ModelRef): Promise<{ provider: string; modelId: string; servedBy: "native" | "openrouter" }> {
    const { provider: pid, modelId } = parseRef(ref);
    const viaOpenRouter = { provider: "openrouter", modelId: pid === "openrouter" ? modelId : modelId.includes("/") ? modelId : `${pid}/${modelId}`, servedBy: "openrouter" as const };
    if (pid === "openrouter") return viaOpenRouter;
    if (mode === "openrouter") return viaOpenRouter;
    if (mode === "mixed" && !(await usable(pid))) return viaOpenRouter;
    return { provider: pid, modelId, servedBy: "native" };
  }

  async function config(task: Task): Promise<TaskConfig> {
    const hit = taskCache.get(task);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.cfg;
    const cfg = (await src.taskSetting?.(task)) ?? src.defaults[task];
    if (!cfg) throw new Error(`llm-router: no model for task "${task}" — pick one in the admin AI console or run: ai-models set ${task} <provider:model>`);
    taskCache.set(task, { at: Date.now(), cfg });
    return cfg;
  }

  async function raw(ref: ModelRef): Promise<LanguageModelV4> {
    const r = await route(ref);
    const p = await provider(r.provider);
    return (typeof p.languageModel === "function" ? p.languageModel(r.modelId) : p(r.modelId)) as LanguageModelV4;
  }

  return {
    mode,
    usable,
    /** Resolved routing for a task — log it with every call (ai-analytics). */
    async resolve(task: Task, ref?: ModelRef): Promise<Resolved> {
      const cfg = await config(task);
      const r = await route(ref ?? cfg.model);
      return { task, ref: ref ?? cfg.model, provider: r.provider, modelId: r.modelId, servedBy: r.servedBy, fallbacks: cfg.fallbacks ?? [] };
    },
    /** Settings the caller should pass through (temperature, maxOutputTokens). */
    settings: async (task: Task) => { const c = await config(task); return { temperature: c.temperature, maxOutputTokens: c.maxOutputTokens }; },
    /** The language model for a task, with fallbacks + the kit middleware already applied.
     *  `ref` (ai-evolve variant) replaces the primary; the task's champion + fallbacks stay behind it,
     *  so a failing challenger degrades to the proven model instead of erroring at a customer. */
    async model(task: Task, ref?: ModelRef): Promise<LanguageModel> {
      const cfg = await config(task);
      const primary = await raw(ref ?? cfg.model);
      const fbs: LanguageModelV4[] = [];
      for (const fb of [...(ref && ref !== cfg.model ? [cfg.model] : []), ...(cfg.fallbacks ?? [])]) { try { fbs.push(await raw(fb)); } catch { /* fallback without a key: skip it */ } }
      const middleware = [...(src.middleware ?? []), ...(fbs.length ? [fallbackMiddleware(fbs)] : [])];
      return middleware.length ? wrapLanguageModel({ model: primary, middleware }) : primary;
    },
    async embedding(task: Task = "embed"): Promise<EmbeddingModelV4> {
      const cfg = await config(task);
      const r = await route(cfg.model);
      const p = await provider(r.provider);
      const make = p.embeddingModel ?? p.textEmbeddingModel ?? p.embedding;
      if (typeof make !== "function") throw new Error(`llm-router: ${r.provider} has no embedding models — point "${task}" at openai:/google:/cohere:/mistral:/openrouter:`);
      return make.call(p, r.modelId) as EmbeddingModelV4;
    },
    /** Call after an admin changes a task or key (live-bus "ai.settings" event). */
    invalidate() { taskCache.clear(); providers.clear(); },
  };
}

export type LlmRouter = ReturnType<typeof createRouter>;
