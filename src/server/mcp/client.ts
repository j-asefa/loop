import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  auth,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { randomBytes } from "node:crypto";
import { db, now } from "../db.js";
import { owned, Problem } from "../domain.js";
import { seal, unseal } from "../secrets.js";
import { safeFetch, safeUrl } from "./network.js";
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
  const fresh = owned<MCPConnection>("mcp_connections", c.id, c.owner_id),
    value = { ...readSecret(fresh), ...patch };
  db.prepare("UPDATE mcp_connections SET secret=? WHERE id=?").run(
    seal(JSON.stringify(value), c.owner_id),
    c.id,
  );
}
export function oauthProvider(c: MCPConnection) {
  let redirect: string | undefined;
  const current = () =>
    readSecret(owned<MCPConnection>("mcp_connections", c.id, c.owner_id));
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
      db.prepare(
        "DELETE FROM oauth_states WHERE connection_id=? OR expires_at<?",
      ).run(c.id, now());
      db.prepare("INSERT INTO oauth_states VALUES(?,?,?,?)").run(
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
        capabilities: {
          extensions: {
            "io.modelcontextprotocol/ui": {
              mimeTypes: ["text/html;profile=mcp-app"],
            },
          },
        } as any,
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
          c.owner_id,
          secret.stdio ||
            (() => {
              throw new Problem(400, "Reconnect this MCP configuration");
            })(),
          metadata.runtimeHostId,
        )
      : new StreamableHTTPClientTransport(connectionUrl(c), {
          requestInit: { headers },
          fetch: safeFetch,
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
      "Could not reach this MCP server. Check the URL, credentials and access.",
    );
  }
}
export async function discover(c: MCPConnection) {
  const client = await connect(c);
  try {
    const capabilities = client.getServerCapabilities();
    async function pages(
      method: "listTools" | "listResources" | "listPrompts",
      key: "tools" | "resources" | "prompts",
    ) {
      const result: any[] = [];
      let cursor: string | undefined;
      do {
        const page = await (client[method] as any)(
          { cursor },
          { timeout: 15000 },
        );
        result.push(...(page[key] || []));
        if (result.length > 300)
          throw new Problem(
            422,
            "Server catalog is too large; use a scoped toolset",
          );
        cursor = page.nextCursor;
      } while (cursor);
      return result;
    }
    const tools = capabilities?.tools ? await pages("listTools", "tools") : [],
      resources = capabilities?.resources
        ? await pages("listResources", "resources")
        : [],
      prompts = capabilities?.prompts
        ? await pages("listPrompts", "prompts")
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
      db.prepare(
        "UPDATE mcp_connections SET tools=?,metadata=?,status='connected' WHERE id=?",
      ).run(JSON.stringify(tools), JSON.stringify(metadata), c.id);
    }).immediate();
    return { tools, metadata };
  } catch (error) {
    if (error instanceof ToolBudgetError)
      db.prepare("UPDATE mcp_connections SET status='disabled' WHERE id=?").run(
        c.id,
      );
    throw error;
  } finally {
    await client.close();
  }
}
