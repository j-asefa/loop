import { afterAll, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const dir = mkdtempSync(join(tmpdir(), "loop-reverse-share-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id } = await import("../src/server/db");
const { config } = await import("../src/server/config");
const { enqueue } = await import("../src/server/queue");
const {
  enrollFederationPeer,
  handleFederationMcp,
  localFederationCatalog,
} = await import("../src/server/mcp/federation");
const { seal } = await import("../src/server/secrets");
const { withTestMcp } = await import("../src/server/mcp/client");
const {
  handleReverseMcp,
  installReverseCatalog,
  pendingReverseCalls,
  completeReverseCall,
  claimReverseCall,
} = await import("../src/server/mcp/reverse");

const server = createServer((req, res) => {
  if (![
    "/api/mcp/reverse",
    "/api/mcp/federation",
  ].includes(req.url || "")) {
    res.writeHead(404).end();
    return;
  }
  void (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
      : undefined;
    if (req.url === "/api/mcp/reverse")
      await handleReverseMcp(req, res, body);
    else await handleFederationMcp(req, res, body);
  })().catch(() => res.writeHead(500).end());
});

it("serves Docker-owned tools over a peer token without copying their credentials", async () => {
  const owner = id();
  const peerId = `laptop:${id()}`;
  const token = enrollFederationPeer(owner, peerId);
  const connection = id();
  db.prepare(
    "INSERT INTO mcp_connections(id,owner_id,name,url,secret,tools,status,created_at) VALUES(?,?,'Source','https://fixture.example/mcp',?,?,'connected',?)",
  ).run(
    connection,
    owner,
    seal('{"type":"none"}', owner),
    JSON.stringify([
      { name: "lookup", inputSchema: { type: "object", properties: {} } },
    ]),
    Date.now(),
  );
  const name = localFederationCatalog(owner)[0].name;
  let calls = 0;
  const restore = withTestMcp(async () => ({
    callTool: async () => {
      calls++;
      return { content: [{ type: "text", text: "source result" }] };
    },
    close: async () => {},
  }) as any);
  const client = new Client({ name: "peer", version: "1" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${config.port}/api/mcp/federation`),
    {
      requestInit: {
        headers: {
          authorization: `Bearer ${token}`,
          "x-loop-run-id": id(),
          "x-loop-call-id": "same-call",
        },
      },
    },
  );
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      name,
    ]);
    const first = await client.callTool({ name, arguments: {} });
    expect(first).toMatchObject({
      content: [{ type: "text", text: "source result" }],
    });
    expect(await client.callTool({ name, arguments: {} })).toEqual(first);
    expect(calls).toBe(1);
  } finally {
    await client.close().catch(() => {});
    restore();
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
config.port = (server.address() as { port: number }).port;
const origin = `http://127.0.0.1:${config.port}/api/mcp/reverse`;

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

it("queues one source-scoped call and returns its durable answer to the Docker agent", async () => {
  const owner = id();
  const peerId = `laptop:${id()}`;
  const token = enrollFederationPeer(owner, peerId);
  const tool = {
    name: "shared_" + "a".repeat(24),
    description: "Fixture: lookup",
    inputSchema: { type: "object", properties: {} },
  };
  const installed = await installReverseCatalog(owner, peerId, "This laptop", [tool]);
  expect(installed.status).toBe("connected");
  const run = enqueue(owner, "Shared tool", id());
  db.prepare("UPDATE runs SET state='running' WHERE id=?").run(run.id);
  const client = new Client({ name: "fixture", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(origin), {
    requestInit: {
      headers: {
        authorization: `Bearer ${token}`,
        "x-loop-run-id": run.id,
        "x-loop-call-id": "call-1",
      },
    },
  });
  await client.connect(transport);
  try {
    const answer = client.callTool({ name: tool.name, arguments: {} });
    let pending: ReturnType<typeof pendingReverseCalls> = [];
    for (let i = 0; i < 30; i++) {
      pending = pendingReverseCalls(owner, peerId);
      if (pending.length) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ runKey: run.id, name: tool.name });
    completeReverseCall(owner, peerId, pending[0].id, "completed", {
      content: [{ type: "text", text: "from laptop" }],
    });
    expect(await answer).toMatchObject({
      content: [{ type: "text", text: "from laptop" }],
    });
    expect(pendingReverseCalls(owner, peerId)).toHaveLength(0);
  } finally {
    await client.close();
  }
});

it("runs a reverse call only after claiming it while still pending for an active run", () => {
  const owner = id();
  const peerId = `laptop:${id()}`;
  enrollFederationPeer(owner, peerId);
  const run = enqueue(owner, "Shared tool", id());
  db.prepare("UPDATE runs SET state='running' WHERE id=?").run(run.id);
  const call = (state: string) => {
    const key = id();
    db.prepare(
      `INSERT INTO mcp_reverse_calls(id,owner_id,peer_id,run_key,request_key,tool_name,args,state,created_at,updated_at)
       VALUES(?,?,?,?,?,'tool','{}',?,?,?)`,
    ).run(key, owner, peerId, run.id, id(), state, Date.now(), Date.now());
    return key;
  };
  const pending = call("pending");
  expect(claimReverseCall(owner, peerId, pending)).toEqual({ claimed: true });
  // A second poll cannot claim it again.
  expect(claimReverseCall(owner, peerId, pending)).toEqual({ claimed: false });
  expect(completeReverseCall(owner, peerId, pending, "completed", {})).toEqual({
    state: "completed",
  });
  // Docker already reported this one as uncertain: it is never run.
  expect(claimReverseCall(owner, peerId, call("unknown"))).toEqual({
    claimed: false,
  });
  const queued = call("pending");
  db.prepare("UPDATE runs SET state='cancelled' WHERE id=?").run(run.id);
  expect(claimReverseCall(owner, peerId, queued)).toEqual({ claimed: false });
  // A claimed call for a run that stopped becomes uncertain, not pending.
  db.prepare("UPDATE runs SET state='running' WHERE id=?").run(run.id);
  const claimed = call("pending");
  claimReverseCall(owner, peerId, claimed);
  db.prepare("UPDATE runs SET state='cancelled' WHERE id=?").run(run.id);
  pendingReverseCalls(owner, peerId);
  expect(
    (db.prepare("SELECT state FROM mcp_reverse_calls WHERE id=?").get(claimed) as any)
      .state,
  ).toBe("unknown");
});
