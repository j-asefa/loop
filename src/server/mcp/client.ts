import * as mcpConnectionsQueries from "../sql/mcp-connections.js";
import * as oauthStatesQueries from "../sql/oauth-states.js";
import {
  diagnosticText,
  errorSummary,
  errorFacts,
} from "../../shared/diagnostics.js";
import { redactCredentials } from "./redaction.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  auth,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { randomBytes } from "node:crypto";
import { db, now } from "../db.js";
import { ownedMcpConnection, Problem } from "../domain.js";
import { seal, unseal } from "../secrets.js";
import { safeFetch, safeToolFetch, safeUrl } from "./network.js";
import { config } from "../config.js";
import { RuntimeTransport } from "./runtime-transport.js";
import { workspaceToolBindings, ToolBudgetError } from "./tool-budget.js";
export type MCPConnection = {
  id: string;
  owner_id: string;
  name: string;
  url: string;
  secret: string;
  status: string;
  tools: string;
  metadata: string;
};
export type AuthSecret = {
  type: "none" | "bearer" | "headers" | "oauth" | "query";
  query?: Record<string, string | string[]>;
  token?: string;
  headers?: Record<string, string>;
  tokens?: any;
  client?: any;
  registeredClient?: boolean;
  verifier?: string;
  discovery?: any;
  stdio?: { command: string; args: string[]; env: Record<string, string> };
};
export function readSecret(c: MCPConnection): AuthSecret {
  return c.secret ? JSON.parse(unseal(c.secret, c.owner_id)) : { type: "none" };
}
export function connectionUrl(c: MCPConnection) {
  const url = safeUrl(c.url);
  // Some publishers require keys in the query string. Keep them encrypted and
  // add them only at the outbound transport boundary, never to public records.
  const secret = readSecret(c);
  for (const [key, value] of Object.entries(secret.query || {})) {
    url.searchParams.delete(key);
    for (const item of Array.isArray(value) ? value : [value])
      url.searchParams.append(key, item);
  }
  return url;
}
function updateSecret(c: MCPConnection, patch: Partial<AuthSecret>) {
  const fresh = ownedMcpConnection(c.id, c.owner_id),
    value = { ...readSecret(fresh), ...patch };
  mcpConnectionsQueries.setSecret(
    db,
    seal(JSON.stringify(value), c.owner_id),
    c.id,
  );
}
export function oauthProvider(c: MCPConnection) {
  let redirect: string | undefined;
  const current = () => readSecret(ownedMcpConnection(c.id, c.owner_id));
  const provider: OAuthClientProvider = {
    get redirectUrl() {
      return config.url + "/api/mcp/oauth/callback";
    },
    get clientMetadata() {
      return {
        client_name: "Loop",
        redirect_uris: [String(this.redirectUrl)],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: current().client?.client_secret
          ? "client_secret_post"
          : "none",
      };
    },
    state() {
      const state = randomBytes(32).toString("hex");
      oauthStatesQueries.removeConnectionOrExpired(db, c.id, now());
      oauthStatesQueries.insert(
        db,
        state,
        c.owner_id,
        c.id,
        now() + 10 * 60 * 1000,
      );
      return state;
    },
    clientInformation() {
      return current().client;
    },
    saveClientInformation(client) {
      updateSecret(c, { client });
    },
    tokens() {
      return current().tokens;
    },
    saveTokens(tokens) {
      updateSecret(c, { tokens });
    },
    saveCodeVerifier(verifier) {
      updateSecret(c, { verifier });
    },
    codeVerifier() {
      const v = current().verifier;
      if (!v) throw new Error("Missing OAuth verifier");
      return v;
    },
    redirectToAuthorization(url) {
      redirect = safeUrl(url).toString();
    },
    saveDiscoveryState(discovery) {
      updateSecret(c, { discovery });
    },
    discoveryState() {
      return current().discovery;
    },
    invalidateCredentials(scope) {
      if (scope === "all")
        updateSecret(c, {
          tokens: undefined,
          client: current().registeredClient ? current().client : undefined,
          verifier: undefined,
          discovery: undefined,
        });
      else if (scope === "tokens") updateSecret(c, { tokens: undefined });
      else if (scope === "client" && !current().registeredClient)
        updateSecret(c, { client: undefined });
      else if (scope === "verifier") updateSecret(c, { verifier: undefined });
      else updateSecret(c, { discovery: undefined });
    },
  };
  return { provider, getRedirect: () => redirect };
}
export async function authorize(c: MCPConnection, code?: string) {
  const p = oauthProvider(c);
  const result = await auth(p.provider, {
    serverUrl: connectionUrl(c),
    authorizationCode: code,
    fetchFn: safeFetch,
  });
  return { result, authorizationUrl: p.getRedirect() };
}
let testFactory: ((c: MCPConnection) => Promise<Client>) | undefined;
export function withTestMcp(factory: (c: MCPConnection) => Promise<Client>) {
  if (process.env.NODE_ENV !== "test") throw new Error("Test-only API");
  testFactory = factory;
  return () => {
    testFactory = undefined;
  };
}
export async function connect(c: MCPConnection): Promise<Client> {
  if (testFactory) return testFactory(c);
  const metadata = JSON.parse(c.metadata);
  if (metadata.transport !== "stdio") safeUrl(c.url);
  const secret = readSecret(c),
    client = new Client(
      { name: "loop", version: "0.1.0" },
      {
        // Loop's conversation flow cannot reliably present interactive MCP forms.
        // Negotiate ordinary tool results instead of the MCP Apps extension.
        capabilities: {},
      },
    );
  const headers =
    secret.type === "bearer"
      ? { Authorization: "Bearer " + secret.token }
      : secret.type === "headers"
        ? secret.headers
        : undefined;
  const oauth = secret.type === "oauth" ? oauthProvider(c) : undefined;
  const transport =
    metadata.transport === "stdio"
      ? new RuntimeTransport(
          secret.stdio ||
            (() => {
              throw new Problem(400, "Reconnect this MCP configuration");
            })(),
        )
      : new StreamableHTTPClientTransport(connectionUrl(c), {
          requestInit: { headers },
          fetch: safeToolFetch,
          authProvider: oauth?.provider,
        });
  try {
    await client.connect(transport, {
      timeout: metadata.transport === "stdio" ? 90000 : 20000,
    });
    return client;
  } catch (error) {
    await client.close().catch(() => {});
    if (oauth?.getRedirect())
      throw new Problem(
        422,
        "MCP sign-in required. Reconnect this tool account.",
      );
    throw new Problem(
      422,
      `Could not reach this MCP server (${errorSummary(error, [], false)}): ${diagnosticText(redactCredentials((error as Error)?.message || "Check the URL, credentials and access.", [secret]))}`,
      errorFacts(error),
    );
  }
}
export async function discover(c: MCPConnection) {
  const client = await connect(c);
  try {
    const capabilities = client.getServerCapabilities();
    async function pages<T>(
      fetch: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>,
    ) {
      const result: T[] = [];
      let cursor: string | undefined;
      do {
        const page = await fetch(cursor);
        result.push(...page.items);
        if (result.length > 300)
          throw new Problem(
            422,
            "Server catalog is too large; use a scoped toolset",
          );
        cursor = page.nextCursor;
      } while (cursor);
      return result;
    }
    const tools = capabilities?.tools
      ? await pages(async (cursor) => {
          const page = await client.listTools({ cursor }, { timeout: 15000 });
          return { items: page.tools, nextCursor: page.nextCursor };
        })
      : [];
    const resources = capabilities?.resources
      ? await pages(async (cursor) => {
          const page = await client.listResources(
            { cursor },
            { timeout: 15000 },
          );
          return { items: page.resources, nextCursor: page.nextCursor };
        })
      : [];
    const prompts = capabilities?.prompts
      ? await pages(async (cursor) => {
          const page = await client.listPrompts({ cursor }, { timeout: 15000 });
          return { items: page.prompts, nextCursor: page.nextCursor };
        })
      : [];
    const metadata = {
      ...JSON.parse(c.metadata),
      capabilities,
      resources,
      prompts,
      checkedAt: now(),
      server: client.getServerVersion(),
    };
    if (JSON.stringify({ tools, metadata }).length > 500000)
      throw new Problem(422, "Server descriptors exceed size limits");
    db.transaction(() => {
      // Concurrent discoveries must check and enable against the same snapshot.
      workspaceToolBindings(c.owner_id, { ...c, tools: JSON.stringify(tools) });
      mcpConnectionsQueries.discovered(
        db,
        JSON.stringify(tools),
        JSON.stringify(metadata),
        c.id,
      );
    }).immediate();
    return { tools, metadata };
  } catch (error) {
    if (error instanceof ToolBudgetError)
      mcpConnectionsQueries.disable(db, c.id);
    throw error;
  } finally {
    await client.close();
  }
}
