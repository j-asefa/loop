import * as mcpConnectionsQueries from "../sql/mcp-connections.js";
import * as oauthStatesQueries from "../sql/oauth-states.js";
import { createHash } from "node:crypto";
import { db, id, now } from "../db.js";
import { ownedMcpConnection, Problem } from "../domain.js";
import { seal } from "../secrets.js";
import { authorize, discover, readSecret, type AuthSecret } from "./client.js";
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
): Promise<CatalogInstallResult> {
  // Serialize the lookup and insert across the API/worker SQLite connections.
  // One catalog installation per workspace, independent of the requesting agent.
  const c = db
    .transaction(() => {
      let existing = mcpConnectionsQueries.byCatalog(db, owner, entry.id);
      // Reuse a manually configured hosted connection, including earlier Datadog installs.
      if (!existing && entry.serverUrl)
        existing = mcpConnectionsQueries.uncataloguedUrl(
          db,
          owner,
          entry.serverUrl,
        );
      const metadata = existing ? JSON.parse(existing.metadata) : {};
      if (existing?.status === "connected" && !Object.keys(values).length) {
        mcpConnectionsQueries.setMetadata(
          db,
          JSON.stringify({ ...metadata, catalogId: entry.id }),
          existing.id,
        );
        return existing;
      }
      const reuse =
        existing &&
        existing.status !== "disconnected" &&
        !Object.keys(values).length;
      const secret = reuse
        ? readSecret(existing!)
        : catalogSecret(entry, values);
      const connection = existing?.id || id();
      const url = "url" in entry.server ? entry.server.url : "stdio:npx";
      const meta = JSON.stringify({
        ...metadata,
        catalogId: entry.id,
        transport: entry.transport,
      });
      if (existing)
        mcpConnectionsQueries.catalogNeedsAuth(
          db,
          seal(JSON.stringify(secret), owner),
          meta,
          connection,
        );
      else
        mcpConnectionsQueries.insertWithMetadata(
          db,
          connection,
          owner,
          entry.name,
          url,
          seal(JSON.stringify(secret), owner),
          meta,
          now(),
        );
      if (!reuse) oauthStatesQueries.removeConnection(db, connection);
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
    mcpConnectionsQueries.setStatus(db, status, c.id);
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
) {
  const entry = catalog.find((c) => c.id === catalogId);
  if (!entry) throw new Problem(404, "Unknown catalog tool");
  if (
    Object.keys(values).some(
      (key) => !entry.inputs.some((input) => input.key === key),
    )
  )
    throw new Problem(400, "Unexpected setup field");
  const key = JSON.stringify([owner, entry.id]);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(Object.entries(values).sort()))
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
  const result = install(owner, entry, values);
  pending.set(key, { fingerprint, result });
  try {
    return await result;
  } finally {
    pending.delete(key);
  }
}
