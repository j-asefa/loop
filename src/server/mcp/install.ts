import * as mcpConnectionsQueries from "../sql/mcp-connections.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { PublicMcpInstall } from "../../shared/mcp-contract-schemas.js";
import { db, id, now } from "../db.js";
import { ownedAgent, ownedMcpConnection, Problem } from "../domain.js";
import { seal } from "../secrets.js";
import { discover } from "./client.js";
import { safeUrl } from "./network.js";
import { privateMcpUrl } from "./credentials.js";
import { ToolBudgetError } from "./tool-budget.js";
const headers = z
  .record(
    z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
    z.string().min(1).max(10000),
  )
  .refine(
    (h) =>
      Object.keys(h).length <= 8 &&
      !Object.keys(h).some((k) =>
        /^(host|cookie|origin|referer|connection|content-length|transfer-encoding|proxy-.*|sec-.*)$/i.test(
          k,
        ),
      ),
    "Unsupported authentication header",
  );
const server = z.union([
  z
    .object({
      command: z.string().regex(/^[A-Za-z0-9_./-]{1,200}$/),
      args: z.array(z.string().max(4000)).max(80).default([]),
      env: z
        .record(
          z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
          z.string().max(10000),
        )
        .default({}),
      type: z.literal("stdio").optional(),
    })
    .strict(),
  z
    .object({
      url: z.string().max(2000),
      headers: headers.optional(),
      type: z.enum(["http", "streamable-http"]).optional(),
    })
    .strict(),
]);
export function parseMcpConfig(input: string | unknown) {
  if (JSON.stringify(input).length > 100000)
    throw new Problem(400, "MCP configuration is too large");
  let value = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new Problem(400, "Paste a valid JSON object containing mcpServers");
    }
  }
  const config = z
    .object({ mcpServers: z.record(z.string().min(1).max(80), server) })
    .strict()
    .parse(value);
  const entries = Object.entries(config.mcpServers);
  if (!entries.length || entries.length > 20)
    throw new Problem(400, "Provide between 1 and 20 MCP servers");
  for (const [, entry] of entries) {
    if ("url" in entry) safeUrl(entry.url);
    else if (Object.keys(entry.env).length > 30)
      throw new Problem(400, "Too many environment variables");
  }
  return entries;
}
export async function installConfig(
  owner: string,
  input: unknown,
  agentId?: string,
) {
  const entries = parseMcpConfig(input);
  if (agentId) ownedAgent(agentId, owner);
  const results: z.input<typeof PublicMcpInstall> = [];
  for (const [name, entry] of entries) {
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([name, entry]))
      .digest("hex");
    let c = mcpConnectionsQueries.byInstallFingerprint(db, owner, fingerprint);
    if (!c) {
      const connection = id(),
        stdio = "command" in entry;
      const stored =
        "command" in entry
          ? {
              url: "stdio:" + entry.command,
              auth: { type: "none", stdio: entry },
            }
          : privateMcpUrl(
              entry.url,
              entry.headers
                ? { type: "headers", headers: entry.headers }
                : { type: "none" },
            );
      mcpConnectionsQueries.insertWithMetadata(
        db,
        connection,
        owner,
        name,
        stored.url,
        seal(JSON.stringify(stored.auth), owner),
        JSON.stringify({
          transport: stdio ? "stdio" : "http",
          installFingerprint: fingerprint,
        }),
        now(),
      );
      c = ownedMcpConnection(connection, owner);
    }
    try {
      await discover(c);
      const fresh = ownedMcpConnection(c.id, owner);
      const tools = JSON.parse(fresh.tools) as { name: string }[];
      results.push({
        id: c.id,
        name,
        status: "connected",
        tools: tools.length,
      });
    } catch (error) {
      results.push({
        id: c.id,
        name,
        status: error instanceof ToolBudgetError ? "disabled" : "needs_auth",
        error:
          error instanceof ToolBudgetError
            ? error.message
            : "Saved, but discovery failed. Check the runtime, package, URL or credentials, then Test / reconnect.",
      });
    }
  }
  return results;
}
