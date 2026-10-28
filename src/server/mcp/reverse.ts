import { MCP_TOOL_BUDGET } from "./tool-budget.js";
import { watchRun } from "../run-signal.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ToolSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { db, emit, id, now } from "../db.js";
import { ownedMcpConnection, Problem } from "../domain.js";
import { seal, unseal } from "../secrets.js";
import { config } from "../config.js";
import { discover, type MCPConnection } from "./client.js";
import { authenticateFederationPeer } from "./federation.js";
import { MCP_TOOL_TIMEOUT_MS } from "./timeouts.js";

type Peer = { id: string; owner_id: string; peer_id: string; secret: string };
type Queued = {
  id: string;
  owner_id: string;
  peer_id: string;
  run_key: string;
  request_key: string;
  tool_name: string;
  args: string;
  state: string;
  result: string | null;
};
const peer = (owner: string, peerId: string) =>
  db
    .prepare(
      "SELECT * FROM mcp_federation_peers WHERE owner_id=? AND peer_id=? AND revoked_at IS NULL",
    )
    .get(owner, peerId) as Peer | undefined;

export async function installReverseCatalog(
  owner: string,
  peerId: string,
  label: string,
  tools: unknown,
) {
  const source = peer(owner, peerId);
  if (!source) throw new Problem(403, "Execution source is not enrolled");
  if (
    !Array.isArray(tools) ||
    tools.length > MCP_TOOL_BUDGET.count ||
    !tools.every(
      (tool: any) =>
        tool &&
        typeof tool.name === "string" &&
        /^shared_[0-9a-f]{24}$/.test(tool.name) &&
        typeof tool.description === "string" &&
        tool.inputSchema &&
        typeof tool.inputSchema === "object",
    ) ||
    Buffer.byteLength(JSON.stringify(tools)) > MCP_TOOL_BUDGET.bytes
  )
    throw new Problem(400, "Invalid shared tool catalog");
  db.prepare(
    `INSERT INTO mcp_reverse_catalog(peer_id,owner_id,tools,updated_at) VALUES(?,?,?,?)
     ON CONFLICT(peer_id) DO UPDATE SET tools=excluded.tools,updated_at=excluded.updated_at`,
  ).run(peerId, owner, JSON.stringify(tools), now());
  const existing = db
    .prepare(
      "SELECT * FROM mcp_connections WHERE owner_id=? AND json_extract(metadata,'$.federatedPeer')=? ORDER BY created_at DESC LIMIT 1",
    )
    .get(owner, peerId) as MCPConnection | undefined;
  const url = `http://127.0.0.1:${config.port}/api/mcp/reverse`;
  const secret = seal(
    JSON.stringify({ type: "bearer", token: unseal(source.secret, owner) }),
    owner,
  );
  const metadata = JSON.stringify({
    transport: "federation",
    federatedPeer: peerId,
    reverse: true,
  });
  const key = existing?.id || id();
  if (existing)
    db.prepare(
      "UPDATE mcp_connections SET name=?,url=?,secret=?,status=CASE WHEN status='disconnected' THEN 'needs_auth' ELSE status END,metadata=? WHERE id=? AND owner_id=?",
    ).run(label, url, secret, metadata, key, owner);
  else
    db.prepare(
      "INSERT INTO mcp_connections(id,owner_id,name,url,secret,status,metadata,created_at) VALUES(?,?,?,?,?,'needs_auth',?,?)",
    ).run(key, owner, label, url, secret, metadata, now());
  await discover(ownedMcpConnection(key, owner));
  return { id: key, status: "connected" };
}

function catalog(owner: string, peerId: string) {
  const row = db
    .prepare(
      "SELECT tools FROM mcp_reverse_catalog WHERE owner_id=? AND peer_id=?",
    )
    .get(owner, peerId) as { tools: string } | undefined;
  return row ? ToolSchema.array().parse(JSON.parse(row.tools)) : [];
}

function queue(
  source: Peer,
  runKey: string,
  requestKey: string,
  name: string,
  args: Record<string, unknown>,
) {
  if (
    !catalog(source.owner_id, source.peer_id).some((tool) => tool.name === name)
  )
    throw new Problem(404, "Shared tool is unavailable");
  const run = db
    .prepare("SELECT state,owner_id FROM runs WHERE id=?")
    .get(runKey) as { state: string; owner_id: string } | undefined;
  if (
    !run ||
    run.owner_id !== source.owner_id ||
    !["running", "awaiting_approval"].includes(run.state)
  )
    throw new Problem(409, "Shared tool run is no longer active");
  const encoded = JSON.stringify(args);
  let saved = db
    .prepare(
      "SELECT * FROM mcp_reverse_calls WHERE peer_id=? AND run_key=? AND request_key=?",
    )
    .get(source.peer_id, runKey, requestKey) as Queued | undefined;
  if (saved) {
    if (saved.tool_name !== name || saved.args !== encoded)
      throw new Problem(409, "Shared tool call identity was reused");
    return saved.id;
  }
  const key = id();
  db.prepare(
    `INSERT INTO mcp_reverse_calls(id,owner_id,peer_id,run_key,request_key,tool_name,args,state,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,'pending',?,?)`,
  ).run(
    key,
    source.owner_id,
    source.peer_id,
    runKey,
    requestKey,
    name,
    encoded,
    now(),
    now(),
  );
  return key;
}

export function pendingReverseCalls(owner: string, peerId: string) {
  if (!peer(owner, peerId))
    throw new Problem(403, "Execution source is not enrolled");
  db.prepare(
    `UPDATE mcp_reverse_calls SET state='unknown',updated_at=?
     WHERE owner_id=? AND peer_id=? AND state IN ('pending','claimed') AND run_key IN
     (SELECT id FROM runs WHERE state NOT IN ('running','awaiting_approval'))`,
  ).run(now(), owner, peerId);
  return db
    .prepare(
      `SELECT id,run_key AS runKey,request_key AS requestKey,tool_name AS name,args
       FROM mcp_reverse_calls WHERE owner_id=? AND peer_id=? AND state='pending'
       ORDER BY created_at LIMIT 20`,
    )
    .all(owner, peerId) as {
    id: string;
    runKey: string;
    requestKey: string;
    name: string;
    args: string;
  }[];
}

// The laptop claims a call immediately before running it. Only a call still
// pending for an active run can be claimed, so a call this source already
// reported as uncertain (timed out, cancelled or disconnected) never runs.
export function claimReverseCall(
  owner: string,
  peerId: string,
  callId: string,
) {
  if (!peer(owner, peerId))
    throw new Problem(403, "Execution source is not enrolled");
  const claimed =
    db
      .prepare(
        `UPDATE mcp_reverse_calls SET state='claimed',updated_at=?
         WHERE id=? AND owner_id=? AND peer_id=? AND state='pending' AND run_key IN
         (SELECT id FROM runs WHERE state IN ('running','awaiting_approval'))`,
      )
      .run(now(), callId, owner, peerId).changes === 1;
  return { claimed };
}

export function completeReverseCall(
  owner: string,
  peerId: string,
  callId: string,
  state: "completed" | "unknown",
  result?: unknown,
) {
  return db
    .transaction(() => {
      if (!peer(owner, peerId))
        throw new Problem(403, "Execution source is not enrolled");
      const saved = db
        .prepare(
          "SELECT * FROM mcp_reverse_calls WHERE id=? AND owner_id=? AND peer_id=?",
        )
        .get(callId, owner, peerId) as Queued | undefined;
      if (!saved) throw new Problem(404, "Shared tool call unavailable");
      const encoded = state === "completed" ? JSON.stringify(result) : null;
      if (encoded && Buffer.byteLength(encoded) > 4 * 1024 * 1024)
        throw new Problem(413, "Shared tool result exceeds size limit");
      if (!["pending", "claimed"].includes(saved.state)) {
        if (saved.state === state && saved.result === encoded) {
          notifySettled(owner, saved.run_key, callId);
          return { state };
        }
        throw new Problem(409, "Shared tool call already resolved");
      }
      db.prepare(
        "UPDATE mcp_reverse_calls SET state=?,result=?,updated_at=? WHERE id=? AND state IN ('pending','claimed')",
      ).run(state, encoded, now(), callId);
      notifySettled(owner, saved.run_key, callId);
      return { state };
    })
    .immediate();
}

function notifySettled(owner: string, run: string, callId: string) {
  // Reverse-call identities outlive a deleted run; keep its known outcome even
  // when there is no run left on which to publish a notification.
  if (
    db.prepare("SELECT 1 FROM runs WHERE id=? AND owner_id=?").get(run, owner)
  )
    emit(owner, run, "reverse.settled", { callId });
}
const waiters = new Map<string, Set<() => void>>();
function markUnknown(owner: string, callId: string) {
  return db
    .transaction(() => {
      const changed = db
        .prepare(
          "UPDATE mcp_reverse_calls SET state='unknown',updated_at=? WHERE id=? AND owner_id=? AND state IN ('pending','claimed') RETURNING run_key",
        )
        .get(now(), callId, owner) as { run_key: string } | undefined;
      if (changed) notifySettled(owner, changed.run_key, callId);
      return !!changed;
    })
    .immediate();
}

/** Shared-call identity is durable; every HTTP waiter observes the same result. */
export async function waitForReverseCall(owner: string, callId: string) {
  const initial = db
    .prepare("SELECT * FROM mcp_reverse_calls WHERE id=? AND owner_id=?")
    .get(callId, owner) as Queued | undefined;
  if (!initial) throw new Problem(404, "Shared tool call unavailable");
  const watched = watchRun({ id: initial.run_key, owner_id: owner });
  let remove: (() => void) | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<any>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Problem, result?: unknown) => {
        if (settled) return;
        settled = true;
        error ? reject(error) : resolve(result);
      };
      const check = () => {
        if (settled) return;
        if (
          !["running", "awaiting_approval"].includes(watched.state || "") ||
          watched.signal.aborted ||
          !peer(owner, initial.peer_id)
        )
          markUnknown(owner, callId);
        const saved = db
          .prepare(
            "SELECT state,result FROM mcp_reverse_calls WHERE id=? AND owner_id=?",
          )
          .get(callId, owner) as Queued | undefined;
        if (saved?.state === "completed")
          settle(undefined, JSON.parse(saved.result!));
        else if (!saved || !["pending", "claimed"].includes(saved.state))
          settle(
            new Problem(
              409,
              "Shared tool outcome is uncertain; inspect it before retrying",
            ),
          );
      };
      const registered = waiters.get(callId) || new Set();
      registered.add(check);
      waiters.set(callId, registered);
      const notify = () => {
        for (const waiter of [...registered]) waiter();
      };
      const unlisten = watched.on("*", notify);
      watched.signal.addEventListener("abort", notify, { once: true });
      remove = () => {
        registered.delete(check);
        if (!registered.size) waiters.delete(callId);
        watched.signal.removeEventListener("abort", notify);
        unlisten();
      };
      deadline = setTimeout(
        () => {
          check();
          if (settled) return;
          // A foreign completion may win between this read and the conditional
          // update. Its known result must still win over the local deadline.
          if (!markUnknown(owner, callId)) {
            check();
            return;
          }
          settle(
            new Problem(
              408,
              "Shared tool response timed out; outcome is uncertain",
            ),
          );
          notify();
        },
        Math.max(1, MCP_TOOL_TIMEOUT_MS - 5000),
      );
      // Completion can have landed before registration, including in another API.
      check();
    });
  } finally {
    clearTimeout(deadline);
    remove?.();
    watched.release();
  }
}

export async function handleReverseMcp(
  req: IncomingMessage,
  res: ServerResponse,
  body: any,
) {
  const source = authenticateFederationPeer(req);
  let queuedKey: string | undefined;
  const server = new Server(
    { name: "Loop shared tools", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: catalog(source.owner_id, source.peer_id),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const runKey = req.headers["x-loop-run-id"];
    const callKey = req.headers["x-loop-call-id"];
    if (typeof runKey !== "string" || !/^[a-f0-9-]{36}$/.test(runKey))
      throw new Problem(400, "Shared tool run identity required");
    if (typeof callKey !== "string" || !callKey || callKey.length > 200)
      throw new Problem(400, "Shared tool call identity required");
    const key = queue(
      source,
      runKey,
      callKey,
      request.params.name,
      request.params.arguments || {},
    );
    queuedKey = key;
    return await waitForReverseCall(source.owner_id, key);
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  res.on("close", () => {
    if (queuedKey) markUnknown(source.owner_id, queuedKey);
    void transport.close();
    void server.close();
  });
  await transport.handleRequest(req, res, body);
}
