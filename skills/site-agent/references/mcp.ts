/**
 * site-agent · MCP — the same action registry as an MCP server, so staff can run the site from
 * Claude / Hermes / any MCP client ("find Jane's order and move her next shipment to Friday"), and
 * external agents can operate the store through exactly the actions you've defined. Nothing new is
 * exposed: same zod inputs, same permissions, same audit trail, channel = "mcp".
 *
 *   HTTP   mount mountMcp(app) → POST/GET/DELETE /api/v1/ai/mcp   (Authorization: Bearer AI_MCP_TOKEN)
 *   stdio  `ai-mcp site` in the repo runs `npm run ai:mcp` → serveStdio()
 * Tokens map to a staff actor + permissions (AI_MCP_TOKENS='[{"token":"…","staffId":"…","permissions":["*"]}]').
 */
import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { z } from "zod";
import { allowed, type ActionDef, type ActionHooks, type Actor } from "./actions";

export function buildMcp(actions: ActionDef[], actor: Actor, hooks: ActionHooks, site = "site") {
  const server = new McpServer({ name: `${site}-ops`, version: "1.0.0" });
  for (const a of actions.filter((x) => allowed(x, actor, "mcp"))) {
    const shape = (a.input as unknown as z.ZodObject<z.ZodRawShape>).shape ?? {};
    server.registerTool(a.name, { description: `${a.description}${a.mode === "write" ? " (writes; audited)" : ""}`, inputSchema: shape }, async (args: Record<string, unknown>) => {
      const ctx = { actor, channel: "mcp" as const, correlationId: randomUUID() };
      try {
        const input = a.input.parse(args);
        const result = await a.run(input, ctx);
        await hooks.record({ action: a.name, ctx, input, status: "executed", result });
        hooks.publish?.("ai.action", { action: a.name, status: "executed", channel: "mcp", summary: a.summarize?.(input) });
        return { content: [{ type: "text" as const, text: JSON.stringify(result ?? { ok: true }) }] };
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        await hooks.record({ action: a.name, ctx, input: args, status: "failed", error });
        return { isError: true, content: [{ type: "text" as const, text: error }] };
      }
    });
  }
  return server;
}

interface TokenEntry { token: string; staffId: string; permissions: string[] }
const tokens = (): TokenEntry[] => { try { return JSON.parse(process.env.AI_MCP_TOKENS ?? "[]"); } catch { return []; } };

/** Stateless Streamable HTTP: a fresh server+transport per request (simple, horizontally safe). */
export function mountMcp(app: Express, actions: ActionDef[], hooks: ActionHooks, path = "/api/v1/ai/mcp") {
  const handle = async (req: Request, res: Response) => {
    const bearer = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const t = tokens().find((x) => x.token && x.token === bearer);
    if (!t) return res.status(401).json({ error: "unauthorized" });
    const server = buildMcp(actions, { kind: "staff", staffId: t.staffId, permissions: t.permissions }, hooks);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
  app.post(path, handle); app.get(path, handle); app.delete(path, handle);
}

export async function serveStdio(actions: ActionDef[], hooks: ActionHooks, staff: { staffId: string; permissions: string[] }) {
  await buildMcp(actions, { kind: "staff", ...staff }, hooks).connect(new StdioServerTransport());
}
