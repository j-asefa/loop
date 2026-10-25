import { createHash } from "node:crypto";
import { db, id, now } from "../db.js";
import { ownedMcpConnection, Problem } from "../domain.js";
import { seal } from "../secrets.js";
import { runtimeEndpoint } from "../runtime-hosts.js";
import {
  authorize,
  discover,
  readSecret,
  type AuthSecret,
  type MCPConnection,
} from "./client.js";
import { catalog, type CatalogDefinition } from "./catalog-data.js";
import type { CatalogInstallResult } from "../../shared/mcp-catalog.js";
import { ToolBudgetError } from "./tool-budget.js";

export function catalogSecret(
  entry: CatalogDefinition,
  values: Record<string, string>,
): AuthSecret {
  for (const input of entry.inputs) {
    if (!values[input.key]?.trim())
      throw new Problem(400, `Enter ${input.label}`);
  }
  if ("package" in entry.server) {
    return {
      type: "none",
      stdio: {
        command: "npx",
        args: ["--yes", entry.server.package, ...entry.server.args],
        env: {
          ...entry.server.env,
          ...Object.fromEntries(
            entry.inputs.map((input) => [input.key, values[input.key].trim()]),
          ),
        },
      },
    };
  }
  if (entry.auth === "oauth-app")
    return {
      type: "oauth",
      registeredClient: true,
      client: {
        client_id: values.clientId.trim(),
        client_secret: values.clientSecret.trim(),
        token_endpoint_auth_method: "client_secret_post",
      },
    };
  if (entry.auth === "bearer")
    return { type: "bearer", token: values.token.trim() };
  if (entry.auth === "query")
    return { type: "query", query: { browserbaseApiKey: values.token.trim() } };
  return { type: entry.auth === "oauth" ? "oauth" : "none" };
}

async function install(
  owner: string,
  entry: CatalogDefinition,
  values: Record<string, string>,
  runtimeHostId?: string,
): Promise<CatalogInstallResult> {
  // Serialize the lookup and insert across the API/worker SQLite connections.
  // One catalog installation per workspace, independent of the requesting agent.
  const c = db
    .transaction(() => {
      let existing = db
        .prepare(
          "SELECT * FROM mcp_connections WHERE owner_id=? AND json_extract(metadata,'$.catalogId')=? ORDER BY created_at LIMIT 1",
        )
        .get(owner, entry.id) as MCPConnection | undefined;
      // Reuse a manually configured hosted connection, including earlier Datadog installs.
      if (!existing && entry.serverUrl)
        existing = db
          .prepare(
            "SELECT * FROM mcp_connections WHERE owner_id=? AND rtrim(url,'/')=rtrim(?,'/') AND json_extract(metadata,'$.catalogId') IS NULL ORDER BY CASE status WHEN 'connected' THEN 0 ELSE 1 END, created_at LIMIT 1",
          )
          .get(owner, entry.serverUrl) as MCPConnection | undefined;
      const metadata = existing ? JSON.parse(existing.metadata) : {};
      if (existing?.status === "connected" && !Object.keys(values).length) {
        db.prepare("UPDATE mcp_connections SET metadata=? WHERE id=?").run(
          JSON.stringify({ ...metadata, catalogId: entry.id }),
          existing.id,
        );
        return existing;
      }
      const reuse =
        existing &&
        existing.status !== "disconnected" &&
        !Object.keys(values).length;
      // A disabled connection keeps its original runtime and credentials on re-enable.
      const host = reuse ? metadata.runtimeHostId : runtimeHostId;
      if (entry.transport === "stdio") runtimeEndpoint(owner, host);
      const secret = reuse
        ? readSecret(existing!)
        : catalogSecret(entry, values);
      const connection = existing?.id || id();
      const url = "url" in entry.server ? entry.server.url : "stdio:npx";
      const meta = JSON.stringify({
        ...metadata,
        catalogId: entry.id,
        transport: entry.transport,
        runtimeHostId: entry.transport === "stdio" ? host : undefined,
      });
      if (existing)
        db.prepare(
          "UPDATE mcp_connections SET secret=?,status='needs_auth',metadata=? WHERE id=?",
        ).run(seal(JSON.stringify(secret), owner), meta, connection);
      else
        db.prepare(
          "INSERT INTO mcp_connections(id,owner_id,name,url,secret,status,metadata,created_at) VALUES(?,?,?,?,?,'needs_auth',?,?)",
        ).run(
          connection,
          owner,
          entry.name,
          url,
          seal(JSON.stringify(secret), owner),
          meta,
          now(),
        );
      if (!reuse)
        db.prepare("DELETE FROM oauth_states WHERE connection_id=?").run(
          connection,
        );
      return ownedMcpConnection(connection, owner);
    })
    .immediate();
  if (c.status === "connected")
    return { id: c.id, status: "connected", tools: JSON.parse(c.tools).length };
  try {
    if (readSecret(c).type === "oauth") {
      const result = await authorize(c);
      if (result.authorizationUrl)
        return {
          id: c.id,
          status: "needs_auth",
          tools: 0,
          authorizationUrl: result.authorizationUrl,
        };
    }
    await discover(c);
    const fresh = ownedMcpConnection(c.id, owner);
    return {
      id: c.id,
      status: "connected",
      tools: JSON.parse(fresh.tools).length,
    };
  } catch (error) {
    const status = error instanceof ToolBudgetError ? "disabled" : "needs_auth";
    db.prepare("UPDATE mcp_connections SET status=? WHERE id=?").run(
      status,
      c.id,
    );
    // Upstream errors can contain keys, query strings or environment variables.
    return {
      id: c.id,
      status,
      tools: 0,
      error:
        error instanceof ToolBudgetError
          ? error.message
          : "Connection saved, but it could not be verified. Check the account requirements and credentials, or retry if the service is unavailable.",
    };
  }
}

const pending = new Map<
  string,
  { fingerprint: string; result: Promise<CatalogInstallResult> }
>();
export async function installCatalog(
  owner: string,
  catalogId: string,
  values: Record<string, string> = {},
  runtimeHostId?: string,
) {
  const entry = catalog.find((c) => c.id === catalogId);
  if (!entry) throw new Problem(404, "Unknown catalog tool");
  if (
    Object.keys(values).some(
      (key) => !entry.inputs.some((input) => input.key === key),
    )
  )
    throw new Problem(400, "Unexpected setup field");
  if (entry.transport === "http" && runtimeHostId)
    throw new Problem(400, "Hosted tools do not use a runtime machine");
  if (runtimeHostId) runtimeEndpoint(owner, runtimeHostId);
  const key = JSON.stringify([owner, entry.id]);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([Object.entries(values).sort(), runtimeHostId]))
    .digest("hex");
  const active = pending.get(key);
  if (active) {
    if (active.fingerprint !== fingerprint)
      throw new Problem(
        409,
        "An installation is already in progress for this tool",
      );
    return active.result;
  }
  const result = install(owner, entry, values, runtimeHostId);
  pending.set(key, { fingerprint, result });
  try {
    return await result;
  } finally {
    pending.delete(key);
  }
}
