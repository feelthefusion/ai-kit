/**
 * AI Kit schema — ONE file, one migration (drizzle-kit generate). Copy to shared/schema/ai.ts and
 * export it from the schema barrel. Money is integer micros of a US dollar (1e-6 $) so fractions
 * of a cent per call add up exactly; the app converts to cents at the edge.
 *
 * ONE WRITER PER TABLE (the owner skill); everyone else reads, or writes through the owner's functions.
 *   llm-router      ai_provider_keys, ai_model_settings, ai_models
 *   site-agent      ai_conversations, ai_messages, ai_actions
 *   ai-channels     (writes conversations/messages through site-agent's store — channel = email|sms|…)
 *   ai-automations  ai_automations, ai_automation_runs
 *   ai-analytics    ai_calls, ai_feedback
 *   ai-evolve       ai_variants, ai_eval_runs
 *   ai-knowledge    ai_knowledge
 *   visitor-intel   ai_visitor_identities  (+ the app's device_visitors table if it has one — helix does)
 *   ml-lab          ai_predictions
 */
import { sql } from "drizzle-orm";
import {
  bigint, boolean, customType, index, integer, jsonb, pgEnum, pgTable, primaryKey, real, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";

/** pgvector column; dimension must match the `embed` task model (ai-knowledge picks it). */
export const vector = (name: string, dims: number) =>
  customType<{ data: number[]; driverData: string }>({
    dataType: () => `vector(${dims})`,
    toDriver: (v) => `[${v.join(",")}]`,
    fromDriver: (v) => JSON.parse(v),
  })(name);

export const aiChannel = pgEnum("ai_channel", ["web", "email", "sms", "whatsapp", "voice", "admin", "automation", "mcp"]);
export const aiActor = pgEnum("ai_actor", ["guest", "customer", "staff", "automation"]);

// ── llm-router ────────────────────────────────────────────────────────────────────────────────
export const aiProviderKeys = pgTable("ai_provider_keys", {
  providerId: text("provider_id").primaryKey(),
  /** AES-256-GCM of the JSON credential map; key = AI_KEYS_SECRET (32 bytes, base64). */
  ciphertext: text("ciphertext").notNull(),
  iv: text("iv").notNull(),
  tag: text("tag").notNull(),
  last4: text("last4").notNull(),
  updatedBy: uuid("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const aiModelSettings = pgTable("ai_model_settings", {
  task: text("task").primaryKey(),
  model: text("model").notNull(),                       // "<provider>:<model>"
  fallbacks: text("fallbacks").array().notNull().default(sql`'{}'::text[]`),
  temperature: real("temperature"),
  maxOutputTokens: integer("max_output_tokens"),
  updatedBy: uuid("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Live catalog cache (ai-models refresh / the catalog job). New rows = new models = ai-evolve candidates. */
export const aiModels = pgTable("ai_models", {
  ref: text("ref").primaryKey(),                        // "openrouter:anthropic/claude-…"
  provider: text("provider").notNull(),
  modelId: text("model_id").notNull(),
  name: text("name"),
  contextLength: integer("context_length"),
  inputMicrosPerMtok: bigint("input_micros_per_mtok", { mode: "number" }),
  outputMicrosPerMtok: bigint("output_micros_per_mtok", { mode: "number" }),
  tools: boolean("tools"),
  modalities: jsonb("modalities").$type<{ input?: string[]; output?: string[] }>(),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
});

// ── site-agent (+ ai-channels) ────────────────────────────────────────────────────────────────
export const aiConversations = pgTable("ai_conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  channel: aiChannel("channel").notNull(),
  visitorId: text("visitor_id"),                        // FingerprintJS id (visitor-intel)
  customerId: uuid("customer_id"),
  address: text("address"),                             // email / E.164 for email+sms threads
  threadKey: text("thread_key"),                        // email Message-ID root / sms pair
  status: text("status").notNull().default("open"),     // open | resolved | handoff
  intent: text("intent"),
  outcome: text("outcome"),                             // resolved_by_ai | handed_off | abandoned | action_done
  attributedOrderId: uuid("attributed_order_id"),
  summary: text("summary"),
  turns: integer("turns").notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  lastAt: timestamp("last_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("ai_conv_visitor").on(t.visitorId),
  index("ai_conv_customer").on(t.customerId),
  uniqueIndex("ai_conv_thread").on(t.channel, t.threadKey),
]);

export const aiMessages = pgTable("ai_messages", {
  id: text("id").primaryKey(),                          // UIMessage id
  conversationId: uuid("conversation_id").notNull(),
  role: text("role").notNull(),                         // user | assistant | system
  parts: jsonb("parts").notNull(),                      // AI SDK UIMessage parts, stored verbatim
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("ai_msg_conv").on(t.conversationId, t.createdAt)]);

/** Every action the AI proposed or ran — the audit trail for "the chat bot changed my address". */
export const aiActions = pgTable("ai_actions", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id"),
  automationRunId: uuid("automation_run_id"),
  action: text("action").notNull(),
  actorKind: aiActor("actor_kind").notNull(),
  actorId: text("actor_id"),
  channel: aiChannel("channel").notNull(),
  input: jsonb("input").notNull(),
  status: text("status").notNull(),                     // proposed | executed | denied | failed
  result: jsonb("result"),
  error: text("error"),
  correlationId: text("correlation_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  executedAt: timestamp("executed_at", { withTimezone: true }),
}, (t) => [index("ai_actions_conv").on(t.conversationId), index("ai_actions_name").on(t.action, t.createdAt)]);

// ── ai-automations ────────────────────────────────────────────────────────────────────────────
export const aiAutomations = pgTable("ai_automations", {
  id: text("id").primaryKey(),                          // = automations/<id>.automation.json
  trigger: text("trigger").notNull(),                   // event name, e.g. "order.delivered"
  spec: jsonb("spec").notNull(),
  active: boolean("active").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const aiAutomationRuns = pgTable("ai_automation_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  automationId: text("automation_id").notNull(),
  eventId: text("event_id").notNull(),
  status: text("status").notNull(),                     // running | done | skipped | failed | dry_run
  actions: integer("actions").notNull().default(0),              // cost: sum(ai_calls.cost_micros) by automation_run_id
  output: jsonb("output"),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
}, (t) => [uniqueIndex("ai_run_once").on(t.automationId, t.eventId)]);  // one run per event: idempotent

// ── ai-analytics ──────────────────────────────────────────────────────────────────────────────
/** One row per model call. The only source for AI cost/latency numbers anywhere in the kit. */
export const aiCalls = pgTable("ai_calls", {
  id: uuid("id").primaryKey().defaultRandom(),
  callId: text("call_id"),
  task: text("task").notNull(),
  ref: text("ref").notNull(),
  provider: text("provider").notNull(),
  modelId: text("model_id").notNull(),
  servedBy: text("served_by").notNull(),                // native | openrouter
  variantId: uuid("variant_id"),
  conversationId: uuid("conversation_id"),
  automationRunId: uuid("automation_run_id"),
  channel: aiChannel("channel"),
  visitorId: text("visitor_id"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  cachedTokens: integer("cached_tokens"),
  costMicros: bigint("cost_micros", { mode: "number" }),
  latencyMs: integer("latency_ms"),
  steps: integer("steps"),
  toolCalls: integer("tool_calls"),
  finishReason: text("finish_reason"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("ai_calls_time").on(t.createdAt), index("ai_calls_task").on(t.task, t.createdAt)]);

export const aiFeedback = pgTable("ai_feedback", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id").notNull(),
  messageId: text("message_id"),
  rating: integer("rating").notNull(),                  // -1 | 1 (thumbs) or 1..5 (CSAT)
  kind: text("kind").notNull().default("thumbs"),       // thumbs | csat
  comment: text("comment"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── ai-evolve ─────────────────────────────────────────────────────────────────────────────────
export const aiVariants = pgTable("ai_variants", {
  id: uuid("id").primaryKey().defaultRandom(),
  task: text("task").notNull(),
  ref: text("ref").notNull(),
  promptVersion: text("prompt_version").notNull().default("v1"),
  status: text("status").notNull(),                     // champion | challenger | retired
  trafficBp: integer("traffic_bp").notNull().default(0),// basis points of live traffic
  evalScore: real("eval_score"),
  liveScore: real("live_score"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
});

export const aiEvalRuns = pgTable("ai_eval_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  variantId: uuid("variant_id"),
  suite: text("suite").notNull(),
  passed: integer("passed").notNull(),
  failed: integer("failed").notNull(),
  score: real("score").notNull(),
  report: jsonb("report"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── ai-knowledge ──────────────────────────────────────────────────────────────────────────────
export const EMBED_DIMS = 1536; // match the embed task model; changing it = new column + re-embed
export const aiKnowledge = pgTable("ai_knowledge", {
  id: uuid("id").primaryKey().defaultRandom(),
  source: text("source").notNull(),                     // product | kb | page | order_faq | policy | doc
  sourceId: text("source_id").notNull(),
  chunk: integer("chunk").notNull().default(0),
  title: text("title"),
  body: text("body").notNull(),
  url: text("url"),
  audience: text("audience").notNull().default("public"), // public | customer | staff
  embedding: vector("embedding", EMBED_DIMS),
  contentHash: text("content_hash").notNull(),          // skip re-embedding unchanged chunks
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("ai_knowledge_src").on(t.source, t.sourceId, t.chunk)]);

// ── visitor-intel ─────────────────────────────────────────────────────────────────────────────
/** Identity graph edges: one FingerprintJS visitor ↔ many identifiers, one identifier ↔ many devices. */
export const aiVisitorIdentities = pgTable("ai_visitor_identities", {
  visitorId: text("visitor_id").notNull(),
  kind: text("kind").notNull(),                         // customer | email | phone | contact | partner_code
  value: text("value").notNull(),
  source: text("source").notNull(),                     // login | checkout | chat | email_click | sms_click | form
  confidenceBp: integer("confidence_bp").notNull().default(10000),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.visitorId, t.kind, t.value] }), index("ai_vid_value").on(t.kind, t.value)]);

// ── live-bus ──────────────────────────────────────────────────────────────────────────────────
/** Outbound webhook subscribers (n8n, Zapier, another site, an external agent). Standard Webhooks signing. */
export const aiWebhookEndpoints = pgTable("ai_webhook_endpoints", {
  id: uuid("id").primaryKey().defaultRandom(),
  url: text("url").notNull(),
  secret: text("secret").notNull(),                     // whsec_… (shown once in the console)
  topics: text("topics").array().notNull().default(sql`'{*}'::text[]`),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── ml-lab ────────────────────────────────────────────────────────────────────────────────────
export const aiPredictions = pgTable("ai_predictions", {
  subject: text("subject").notNull(),                   // "customer:<id>" | "visitor:<id>" | "product:<slug>"
  model: text("model").notNull(),                       // recs_v1 | intent_v2 | anomaly_v1 …
  value: jsonb("value").notNull(),
  score: real("score"),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.subject, t.model] })]);
