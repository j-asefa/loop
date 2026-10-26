import type { QueryRow } from "../query-records.js";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ToolSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { db, emit, id, now } from "../db.js";
import { ownedMcpConnection, Problem } from "../domain.js";
import { seal, unseal } from "../secrets.js";
import { authorizeConnectionTool } from "./broker.js";
import { connect, discover, readSecret, type MCPConnection } from "./client.js";
import { redactCredentials } from "./redaction.js";
import { MCP_TOOL_TIMEOUT_MS } from "./timeouts.js";
import { isGithubMcpUrl } from "../../shared/github.js";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
type Peer = {
  id: string;
  owner_id: string;
  peer_id: string;
  token_hash: string;
  secret: string;
  revoked_at: number | null;
};
type Binding = {
  name: string;
  connectionId: string;
  tool: string;
  description: string;
  inputSchema: import("@modelcontextprotocol/sdk/types.js").Tool["inputSchema"];
  github: boolean;
  alwaysAsk: boolean;
};

// Tokens are issued only by source-side enrollment, never by a browser route.
// A repeated enrollment returns the same token, so a lost response cannot
// revoke a live peer connection or create an uncertain replacement.
export function enrollFederationPeer(owner: string, peerId: string) {
  if (!/^[a-z][a-z0-9-]{0,31}:[a-zA-Z0-9._~-]{1,128}$/.test(peerId))
    throw new Problem(400, "Invalid execution source");
  return db
    .transaction(() => {
      let row = db
        .prepare(
          "SELECT * FROM mcp_federation_peers WHERE owner_id=? AND peer_id=?",
        )
        .get(owner, peerId) as Peer | undefined;
      if (!row || row.revoked_at) {
        const token = randomBytes(32).toString("hex");
        db.prepare(
          `INSERT INTO mcp_federation_peers(id,owner_id,peer_id,secret,token_hash,created_at,revoked_at,revoke_synced_at)
           VALUES(?,?,?,?,?,?,NULL,NULL) ON CONFLICT(owner_id,peer_id) DO UPDATE SET
           secret=excluded.secret,token_hash=excluded.token_hash,created_at=excluded.created_at,revoked_at=NULL,revoke_synced_at=NULL`,
        ).run(id(), owner, peerId, seal(token, owner), hash(token), now());
        row = db
          .prepare(
            "SELECT * FROM mcp_federation_peers WHERE owner_id=? AND peer_id=?",
          )
          .get(owner, peerId) as Peer;
      }
      return unseal(row.secret, owner);
    })
    .immediate();
}

export function revokeFederationPeer(
  owner: string,
  peerId: string,
  synced = false,
) {
  return db
    .transaction(() => {
      db.prepare(
        `UPDATE mcp_federation_peers SET revoked_at=coalesce(revoked_at,?),
         revoke_synced_at=CASE WHEN ? THEN ? ELSE revoke_synced_at END,
         secret=? WHERE owner_id=? AND peer_id=?`,
      ).run(now(), synced ? 1 : 0, now(), seal("", owner), owner, peerId);
      db.prepare(
        `UPDATE mcp_connections SET status='disconnected',secret=?
         WHERE owner_id=? AND json_extract(metadata,'$.federatedPeer')=?`,
      ).run(seal(JSON.stringify({ type: "none" }), owner), owner, peerId);
      const calls = db
        .prepare(
          "UPDATE mcp_reverse_calls SET state='unknown',updated_at=? WHERE owner_id=? AND peer_id=? AND state IN ('pending','claimed') RETURNING id,run_key",
        )
        .all(now(), owner, peerId) as { id: string; run_key: string }[];
      for (const call of calls)
        if (
          db
            .prepare("SELECT 1 FROM runs WHERE id=? AND owner_id=?")
            .get(call.run_key, owner)
        )
          emit(owner, call.run_key, "reverse.settled", { callId: call.id });
      return { peerId, revoked: true };
    })
    .immediate();
}

/** Sent only by the local source adapter on federation setup requests. */
export const FEDERATION_SETUP_HEADER = "x-loop-source-setup";

export function federationUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Problem(400, "Invalid execution source endpoint");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !["/api/mcp/federation", "/api/mcp/reverse"].includes(url.pathname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Problem(400, "Unsupported execution source endpoint");
  return url;
}

export async function installFederationPeer(
  owner: string,
  peerId: string,
  label: string,
  endpoint: string,
  token: string,
) {
  if (!/^[a-z][a-z0-9-]{0,31}:[a-zA-Z0-9._~-]{1,128}$/.test(peerId))
    throw new Problem(400, "Invalid execution source");
  if (token.length !== 64 || !/^[0-9a-f]+$/.test(token))
    throw new Problem(400, "Invalid execution source credential");
  const url = federationUrl(endpoint).toString();
  const existing = db
    .prepare(
      "SELECT * FROM mcp_connections WHERE owner_id=? AND json_extract(metadata,'$.federatedPeer')=? ORDER BY created_at DESC LIMIT 1",
    )
    .get(owner, peerId) as MCPConnection | undefined;
  const secret = seal(JSON.stringify({ type: "bearer", token }), owner);
  const metadata = JSON.stringify({
    transport: "federation",
    federatedPeer: peerId,
  });
  const connectionId = existing?.id || id();
  if (existing)
    db.prepare(
      "UPDATE mcp_connections SET name=?,url=?,secret=?,status=CASE WHEN status='disconnected' THEN 'needs_auth' ELSE status END,metadata=? WHERE id=? AND owner_id=?",
    ).run(label, url, secret, metadata, connectionId, owner);
  else
    db.prepare(
      "INSERT INTO mcp_connections(id,owner_id,name,url,secret,status,metadata,created_at) VALUES(?,?,?,?,?,'needs_auth',?,?)",
    ).run(connectionId, owner, label, url, secret, metadata, now());
  await discover(ownedMcpConnection(connectionId, owner));
  return { id: connectionId, status: "connected" };
}

export function authenticateFederationPeer(req: IncomingMessage): Peer {
  const value = req.headers.authorization;
  const token =
    typeof value === "string" && /^Bearer ([0-9a-f]{64})$/.exec(value)?.[1];
  if (!token || req.headers.origin || req.headers["sec-fetch-site"])
    throw new Problem(403, "Execution source credential required");
  const tokenHash = hash(token);
  const row = db
    .prepare(
      "SELECT * FROM mcp_federation_peers WHERE token_hash=? AND revoked_at IS NULL",
    )
    .get(tokenHash) as Peer | undefined;
  if (
    !row ||
    !timingSafeEqual(Buffer.from(tokenHash), Buffer.from(row.token_hash))
  )
    throw new Problem(403, "Execution source credential required");
  return row;
}

function sourceBindings(owner: string): Binding[] {
  const rows = db
    .prepare(
      `SELECT * FROM mcp_connections WHERE owner_id=? AND status='connected'
       AND coalesce(json_extract(metadata,'$.transport'),'http')<>'federation' ORDER BY id`,
    )
    .all(owner) as MCPConnection[];
  return rows.flatMap((connection) =>
    ToolSchema.array()
      .parse(JSON.parse(connection.tools))
      .map((tool) => ({
        name:
          "shared_" +
          hash(JSON.stringify([connection.id, tool.name])).slice(0, 24),
        connectionId: connection.id,
        tool: tool.name,
        description: `${connection.name}: ${String(tool.description || tool.name).slice(0, 1500)}`,
        inputSchema: tool.inputSchema,
        github: isGithubMcpUrl(connection.url),
        // Shared GitHub merges follow the executing owner's approval policy too.
        alwaysAsk: false,
      })),
  );
}
export function localFederationCatalog(owner: string) {
  return sourceBindings(owner).map((binding) => ({
    name: binding.name,
    description: binding.description,
    inputSchema: binding.inputSchema,
    _meta: {
      loop: {
        github: binding.github,
        alwaysAsk: binding.alwaysAsk,
        sourceTool: binding.tool,
      },
    },
  }));
}

type SharedClient = {
  client: Promise<Awaited<ReturnType<typeof connect>>>;
  at: number;
};
const clients = new Map<string, SharedClient>();
const CLIENT_IDLE_MS = 10 * 60_000;
// Close idle shared clients (and any stdio processes behind them) on a
// timer, not only when another call happens to arrive.
function evictIdleClients() {
  for (const [key, entry] of clients)
    if (now() - entry.at > CLIENT_IDLE_MS) {
      clients.delete(key);
      void entry.client.then((client) => client.close()).catch(() => {});
    }
}
setInterval(evictIdleClients, 60_000).unref();
async function clientFor(
  peer: Peer,
  runKey: string,
  connection: MCPConnection,
) {
  const key = `${peer.id}:${runKey}:${connection.id}:${hash(
    JSON.stringify([
      connection.secret,
      connection.url,
      JSON.parse(connection.metadata).runtimeHostId,
    ]),
  )}`;
  evictIdleClients();
  const saved = clients.get(key);
  if (saved) {
    saved.at = now();
    return saved.client;
  }
  if (clients.size >= 200)
    throw new Problem(429, "Too many active shared tool sessions");
  const entry = { client: connect(connection), at: now() };
  clients.set(key, entry);
  try {
    return await entry.client;
  } catch (error) {
    clients.delete(key);
    throw error;
  }
}

async function call(
  peer: Peer,
  runKey: string,
  requestKey: string,
  name: string,
  args: Record<string, unknown>,
) {
  const binding = sourceBindings(peer.owner_id).find(
    (item) => item.name === name,
  );
  if (!binding) throw new Problem(404, "Shared tool is no longer available");
  const { connection } = authorizeConnectionTool(
    peer.owner_id,
    binding.connectionId,
    binding.tool,
    args,
  );
  const encodedArgs = JSON.stringify(args);
  const saved = db
    .prepare(
      "SELECT * FROM mcp_federation_calls WHERE peer_id=? AND run_key=? AND request_key=?",
    )
    .get(peer.id, runKey, requestKey) as
    QueryRow<"mcp_federation_calls"> | undefined;
  if (saved) {
    if (saved.tool_name !== name || saved.args !== encodedArgs)
      throw new Problem(409, "Shared tool call identity was reused");
    if (saved.state === "completed") {
      if (saved.result === null)
        throw new Problem(
          409,
          `Shared tool call ${saved.id} has no saved result`,
        );
      return JSON.parse(saved.result);
    }
    throw new Problem(
      409,
      "Shared tool outcome is uncertain; inspect it before retrying",
    );
  }
  // Connect before recording the call: a busy client pool or a failed
  // connection sends nothing, so it must stay retryable, not uncertain.
  const client = await clientFor(peer, runKey, connection);
  const key = id();
  const recorded = db
    .prepare(
      `INSERT INTO mcp_federation_calls(id,owner_id,peer_id,run_key,request_key,tool_name,args,state,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,'executing',?,?) ON CONFLICT(peer_id,run_key,request_key) DO NOTHING`,
    )
    .run(
      key,
      peer.owner_id,
      peer.id,
      runKey,
      requestKey,
      name,
      encodedArgs,
      now(),
      now(),
    ).changes;
  // The same identity arrived concurrently while this one connected.
  if (!recorded)
    throw new Problem(
      409,
      "Shared tool outcome is uncertain; inspect it before retrying",
    );
  try {
    const response = await client.callTool(
      { name: binding.tool, arguments: args },
      undefined,
      { timeout: MCP_TOOL_TIMEOUT_MS },
    );
    const clean = redactCredentials(response, [
      readSecret(connection),
      readSecret(ownedMcpConnection(connection.id, peer.owner_id)),
    ]);
    const result = JSON.stringify(clean);
    if (Buffer.byteLength(result) > 4 * 1024 * 1024)
      throw new Problem(413, "Shared tool result exceeds size limit");
    db.prepare(
      "UPDATE mcp_federation_calls SET state='completed',result=?,updated_at=? WHERE id=?",
    ).run(result, now(), key);
    return clean;
  } catch {
    db.prepare(
      "UPDATE mcp_federation_calls SET state='unknown',updated_at=? WHERE id=?",
    ).run(now(), key);
    throw new Problem(
      409,
      "Shared tool outcome is uncertain; inspect it before retrying",
    );
  }
}
export async function invokeLocalFederatedTool(
  owner: string,
  peerId: string,
  runKey: string,
  requestKey: string,
  name: string,
  args: Record<string, unknown>,
) {
  const peer = db
    .prepare(
      "SELECT * FROM mcp_federation_peers WHERE owner_id=? AND peer_id=? AND revoked_at IS NULL",
    )
    .get(owner, peerId) as Peer | undefined;
  if (!peer) throw new Problem(403, "Execution source is not shared");
  return call(peer, runKey, requestKey, name, args);
}

/** Token-only MCP endpoint. Mount it before browser authentication or on an
 * isolated listener; no paired/browser API can issue a token. */
export async function handleFederationMcp(
  req: IncomingMessage,
  res: ServerResponse,
  body: any,
) {
  const peer = authenticateFederationPeer(req);
  const server = new Server(
    { name: "Loop shared tools", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: localFederationCatalog(peer.owner_id),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    // Each source run owns its request IDs. Never deduplicate two different
    // runs merely because their MCP clients both started at JSON-RPC id 1.
    const runKey = req.headers["x-loop-run-id"];
    const callKey = req.headers["x-loop-call-id"];
    if (typeof runKey !== "string" || !/^[a-f0-9-]{36}$/.test(runKey))
      throw new Problem(400, "Shared tool run identity required");
    if (typeof callKey !== "string" || !callKey || callKey.length > 200)
      throw new Problem(400, "Shared tool call identity required");
    return CallToolResultSchema.parse(
      await call(
        peer,
        runKey,
        callKey,
        request.params.name,
        request.params.arguments || {},
      ),
    );
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await transport.handleRequest(req, res, body);
}
