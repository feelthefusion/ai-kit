/**
 * site-agent · action registry — the ONLY way AI touches the site.
 *
 * Every capability the chat bot, email/SMS bot, automations and the admin copilot have is an
 * action declared here. An action wraps an EXISTING service function of the app (the same one
 * the account page / admin console calls), so AI and UI can never disagree (consistency).
 * There is no generic SQL tool, no HTTP tool, no code tool: the model can only do what is listed.
 *
 * Safety is structural, not a prompt:
 *   • WHO  — the actor (customer id, staff permissions) comes from the server session and is
 *            closed over by each tool. It is never a model input, so it can't be forged or
 *            prompt-injected ("I'm customer 42" does nothing).
 *   • WHAT — zod input schemas; unknown keys are stripped; ownership re-checked in `run`.
 *   • WHEN — writes default to `confirm`: the agent emits a signed approval request
 *            (experimental_toolApprovalSecret, HMAC over tool + call id + input), the customer
 *            taps Confirm, THEN it runs. Tampered/forged approvals fail closed.
 *   • TRACE — every proposal/execution is an ai_actions row + the app's audit_events row +
 *            a live-bus event, so admins watch the bot act in real time.
 */
import { tool, type ToolApprovalStatus, type ToolSet } from "ai";
import { z } from "zod";

export type Actor =
  | { kind: "guest"; visitorId?: string }
  | { kind: "customer"; customerId: string; visitorId?: string }
  | { kind: "staff"; staffId: string; permissions: string[] }
  | { kind: "automation"; automationId: string; permissions: string[] };

export type Channel = "web" | "email" | "sms" | "whatsapp" | "voice" | "admin" | "automation" | "mcp";

export interface ActionCtx {
  actor: Actor;
  channel: Channel;
  conversationId?: string;
  correlationId: string;
  /** Resolved customer for customer-scoped actions (the actor's own id; staff may pass one). */
  customerId?: string;
}

export interface ActionDef<I extends z.ZodTypeAny = z.ZodTypeAny, O = unknown> {
  name: string;
  /** Written for the model: when to use it, what it changes. Plain, short. */
  description: string;
  input: I;
  /** Minimum actor. "customer" actions run on the actor's OWN record only. */
  scope: "guest" | "customer" | "staff";
  /** Staff/automation permission (the app's existing RBAC string, e.g. "customers:write"). */
  permission?: string;
  mode: "read" | "write";
  /** Ask the human before running. Default: writes by customers/guests confirm; staff reads don't. */
  confirm?: boolean | ((input: z.infer<I>, ctx: ActionCtx) => boolean);
  /** Human sentence shown on the Confirm card and in the audit log. */
  summarize?: (input: z.infer<I>) => string;
  /** Channels allowed (default all). e.g. refunds: ["admin", "mcp"]. */
  channels?: Channel[];
  run: (input: z.infer<I>, ctx: ActionCtx) => Promise<O>;
}

export interface ActionHooks {
  /** ai_actions insert/update + audit_events (the app's audit()) — same transaction as the write when possible. */
  record: (e: { action: string; ctx: ActionCtx; input: unknown; status: "proposed" | "executed" | "denied" | "failed"; result?: unknown; error?: string }) => Promise<void>;
  /** live-bus publish("ai.action", …) so the admin console updates instantly. */
  publish?: (event: string, data: unknown) => void;
}

export const defineAction = <I extends z.ZodTypeAny, O>(a: ActionDef<I, O>) => a;

const rank = { guest: 0, customer: 1, staff: 2 } as const;

/** Is this actor allowed to see/use this action at all? (filtering happens BEFORE the model sees tools) */
export function allowed(a: ActionDef, actor: Actor, channel: Channel): boolean {
  if (a.channels && !a.channels.includes(channel)) return false;
  const level = actor.kind === "automation" ? rank.staff : rank[actor.kind];
  if (level < rank[a.scope]) return false;
  if (a.permission && (actor.kind === "staff" || actor.kind === "automation")) return actor.permissions.includes(a.permission) || actor.permissions.includes("*");
  return true;
}

function needsConfirm(a: ActionDef, input: unknown, ctx: ActionCtx): boolean {
  if (typeof a.confirm === "function") return a.confirm(input as never, ctx);
  if (typeof a.confirm === "boolean") return a.confirm;
  if (a.mode === "read") return false;
  return ctx.actor.kind === "customer" || ctx.actor.kind === "guest"; // staff/automation writes run; they are audited
}

/**
 * Build the tool set for ONE request. The actor is captured in closures here — the model only
 * ever supplies the zod input. Tools the actor can't use are not in the set at all.
 */
export function buildTools(actions: ActionDef[], base: Omit<ActionCtx, "customerId">, hooks: ActionHooks) {
  const ctx: ActionCtx = { ...base, customerId: base.actor.kind === "customer" ? base.actor.customerId : undefined };
  const visible = actions.filter((a) => allowed(a, base.actor, base.channel));
  const tools: ToolSet = {};
  for (const a of visible) {
    tools[a.name] = tool({
      description: a.description,
      inputSchema: a.input,
      execute: async (input: unknown) => {
        try {
          const result = await a.run(input as never, ctx);
          await hooks.record({ action: a.name, ctx, input, status: "executed", result });
          hooks.publish?.("ai.action", { action: a.name, status: "executed", channel: ctx.channel, conversationId: ctx.conversationId, summary: a.summarize?.(input as never) });
          return result;
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          await hooks.record({ action: a.name, ctx, input, status: "failed", error });
          hooks.publish?.("ai.action", { action: a.name, status: "failed", channel: ctx.channel, conversationId: ctx.conversationId });
          return { ok: false, error }; // the model explains it; it never sees a stack trace
        }
      },
    });
  }
  const byName = new Map(visible.map((a) => [a.name, a]));
  /** ToolLoopAgent `toolApproval` — confirm-before-write, decided on the parsed input. */
  const toolApproval = ({ toolCall }: { toolCall: { toolName: string; input: unknown } }): ToolApprovalStatus => {
    const a = byName.get(toolCall.toolName);
    if (!a) return { type: "denied", reason: "Not available here." };
    if (!needsConfirm(a, toolCall.input, ctx)) return undefined;
    void hooks.record({ action: a.name, ctx, input: toolCall.input, status: "proposed" }).catch(() => {});
    hooks.publish?.("ai.action", { action: a.name, status: "proposed", channel: ctx.channel, conversationId: ctx.conversationId, summary: a.summarize?.(toolCall.input as never) });
    return { type: "user-approval", reason: a.summarize?.(toolCall.input as never) ?? `Run ${a.name}?` };
  };
  return { tools, toolApproval, visible };
}

// ── Starter actions (adapt `run` to the app's real services; keep names stable — evals use them) ──

/** Shape of the app services these starters call. Implement with the app's existing functions. */
export interface SiteServices {
  getOrderStatus(customerId: string, orderNumber?: string): Promise<unknown>;
  listSubscriptions(customerId: string): Promise<unknown>;
  updateSubscription(customerId: string, subscriptionId: string, change: { action: "pause" | "resume" | "skip_next" | "change_frequency" | "change_next_date" | "cancel"; frequencyDays?: number; nextDate?: string }): Promise<unknown>;
  updateShippingAddress(customerId: string, address: Address, scope: { subscriptionId?: string; makeDefault?: boolean }): Promise<unknown>;
  updateProfile(customerId: string, patch: { firstName?: string; lastName?: string; phone?: string; marketingEmail?: boolean; marketingSms?: boolean }): Promise<unknown>;
  searchCatalog(query: string): Promise<unknown>;
  addToCart(visitorId: string, slug: string, qty: number): Promise<unknown>;
  handoff(conversationId: string | undefined, reason: string): Promise<unknown>;
  // staff
  findCustomer(q: string): Promise<unknown>;
  staffUpdateCustomer(customerId: string, patch: Record<string, unknown>, reason: string): Promise<unknown>;
}

export const AddressInput = z.object({
  name: z.string().min(1).max(120),
  line1: z.string().min(1).max(200),
  line2: z.string().max(200).optional(),
  city: z.string().min(1).max(120),
  region: z.string().min(1).max(80),
  postalCode: z.string().min(2).max(20),
  country: z.string().length(2).default("US"),
});
export type Address = z.infer<typeof AddressInput>;

const own = (ctx: ActionCtx) => {
  if (!ctx.customerId) throw new Error("Sign in first so I can see your account.");
  return ctx.customerId;
};

export function starterActions(s: SiteServices): ActionDef[] {
  return [
    defineAction({
      name: "track_order", mode: "read", scope: "customer",
      description: "Status, carrier and tracking link for the customer's order. Without an order number: their most recent orders.",
      input: z.object({ orderNumber: z.string().max(40).optional() }),
      run: (i, ctx) => s.getOrderStatus(own(ctx), i.orderNumber),
    }),
    defineAction({
      name: "list_subscriptions", mode: "read", scope: "customer",
      description: "The customer's subscriptions with status, items, frequency and next ship date.",
      input: z.object({}),
      run: (_i, ctx) => s.listSubscriptions(own(ctx)),
    }),
    defineAction({
      name: "update_subscription", mode: "write", scope: "customer",
      description: "Pause, resume, skip the next shipment, change frequency, change the next date, or cancel one of the customer's subscriptions. Call list_subscriptions first to get the id.",
      input: z.object({
        subscriptionId: z.string().uuid(),
        action: z.enum(["pause", "resume", "skip_next", "change_frequency", "change_next_date", "cancel"]),
        frequencyDays: z.number().int().min(7).max(365).optional(),
        nextDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      }),
      summarize: (i) => ({ pause: "Pause this subscription", resume: "Resume this subscription", skip_next: "Skip the next shipment", change_frequency: `Ship every ${i.frequencyDays} days`, change_next_date: `Move the next shipment to ${i.nextDate}`, cancel: "Cancel this subscription" })[i.action],
      run: (i, ctx) => s.updateSubscription(own(ctx), i.subscriptionId, i),
    }),
    defineAction({
      name: "update_shipping_address", mode: "write", scope: "customer",
      description: "Change the customer's shipping address: their default, one subscription's, or both. Collect every field first and read it back.",
      input: z.object({ address: AddressInput, subscriptionId: z.string().uuid().optional(), makeDefault: z.boolean().default(true) }),
      summarize: (i) => `Ship to ${i.address.name}, ${i.address.line1}${i.address.line2 ? ` ${i.address.line2}` : ""}, ${i.address.city}, ${i.address.region} ${i.address.postalCode}`,
      run: (i, ctx) => s.updateShippingAddress(own(ctx), i.address, { subscriptionId: i.subscriptionId, makeDefault: i.makeDefault }),
    }),
    defineAction({
      name: "update_profile", mode: "write", scope: "customer",
      description: "Update the customer's name, phone, or email/SMS preferences.",
      input: z.object({ firstName: z.string().max(80).optional(), lastName: z.string().max(80).optional(), phone: z.string().max(20).optional(), marketingEmail: z.boolean().optional(), marketingSms: z.boolean().optional() }),
      summarize: (i) => `Update ${Object.keys(i).join(", ")}`,
      run: (i, ctx) => s.updateProfile(own(ctx), i),
    }),
    defineAction({
      name: "search_catalog", mode: "read", scope: "guest",
      description: "Find products on this site by name, category or need. Use before recommending anything.",
      input: z.object({ query: z.string().min(1).max(120) }),
      run: (i) => s.searchCatalog(i.query),
    }),
    defineAction({
      name: "add_to_cart", mode: "write", scope: "guest", confirm: false, channels: ["web"],
      description: "Add a product to the visitor's cart (they can remove it any time).",
      input: z.object({ slug: z.string().max(80), qty: z.number().int().min(1).max(99).default(1) }),
      run: (i, ctx) => s.addToCart(ctx.actor.kind === "guest" || ctx.actor.kind === "customer" ? ctx.actor.visitorId ?? "" : "", i.slug, i.qty),
    }),
    defineAction({
      name: "handoff_to_human", mode: "write", scope: "guest", confirm: false,
      description: "Hand the conversation to the team when the customer asks for a person or you can't resolve it.",
      input: z.object({ reason: z.string().max(300) }),
      run: (i, ctx) => s.handoff(ctx.conversationId, i.reason),
    }),
    // ── staff copilot (admin console, MCP) ──
    defineAction({
      name: "find_customer", mode: "read", scope: "staff", permission: "customers:read", channels: ["admin", "mcp", "automation"],
      description: "Look up customers by email, phone, name or order number.",
      input: z.object({ q: z.string().min(2).max(120) }),
      run: (i) => s.findCustomer(i.q),
    }),
    defineAction({
      name: "staff_update_customer", mode: "write", scope: "staff", permission: "customers:write", channels: ["admin", "mcp", "automation"],
      description: "Change any field on a customer record (address, profile, tags, notes). Always pass a reason; it is written to the audit log.",
      input: z.object({ customerId: z.string().uuid(), patch: z.record(z.string(), z.unknown()), reason: z.string().min(3).max(300) }),
      summarize: (i) => `Update customer ${i.customerId}: ${Object.keys(i.patch).join(", ")} (${i.reason})`,
      run: (i) => s.staffUpdateCustomer(i.customerId, i.patch, i.reason),
    }),
  ] as ActionDef[];
}
