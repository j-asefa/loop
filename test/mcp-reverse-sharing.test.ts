import express from "express";
import Database from "better-sqlite3";
import { until } from "./helpers";
import { afterAll, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const dir = mkdtempSync(join(tmpdir(), "loop-reverse-share-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_MCP_TOOL_TIMEOUT_MS = "8000";
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, changes } = await import("../src/server/db");
const { config } = await import("../src/server/config");
const { enqueue } = await import("../src/server/queue");
const {
  enrollFederationPeer,
  revokeFederationPeer,
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
  waitForReverseCall,
} = await import("../src/server/mcp/reverse");

const { core } = await import("../src/server/core-routes");
const app = express();
app.use(express.json(), (req, res, next) => {
  res.locals.owner = req.get("x-owner");
  next();
});
app.use(core);
const server = createServer((req, res) => {
  if (req.url?.startsWith("/runs/")) return app(req, res);
  if (!["/api/mcp/reverse", "/api/mcp/federation"].includes(req.url || "")) {
    res.writeHead(404).end();
    return;
  }
  void (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
      : undefined;
    if (req.url === "/api/mcp/reverse") await handleReverseMcp(req, res, body);
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
  const restore = withTestMcp(
    async () =>
      ({
        callTool: async () => {
          calls++;
          return { content: [{ type: "text", text: "source result" }] };
        },
        close: async () => {},
      }) as any,
  );
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
  const installed = await installReverseCatalog(owner, peerId, "This laptop", [
    tool,
  ]);
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
    (
      db
        .prepare("SELECT state FROM mcp_reverse_calls WHERE id=?")
        .get(claimed) as any
    ).state,
  ).toBe("unknown");
});

async function sharedFixture() {
  const owner = id(),
    peerId = `laptop:${id()}`;
  const token = enrollFederationPeer(owner, peerId);
  const name = "shared_" + "b".repeat(24);
  await installReverseCatalog(owner, peerId, "Wait fixture", [
    { name, description: "Wait", inputSchema: { type: "object" } },
  ]);
  const run = enqueue(owner, "Wait", id());
  db.prepare("UPDATE runs SET state='running' WHERE id=?").run(run.id);
  const clients: Client[] = [];
  const call = async () => {
    const client = new Client({ name: "waiter", version: "1" });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(origin), {
        requestInit: {
          headers: {
            authorization: `Bearer ${token}`,
            "x-loop-run-id": run.id,
            "x-loop-call-id": "shared-request",
          },
        },
      }),
    );
    const answer = client
      .callTool({ name, arguments: {} })
      .catch((error: Error) => ({ error: error.message }));
    return { answer };
  };
  return {
    owner,
    peerId,
    run,
    call,
    async close() {
      await Promise.all(clients.map((client) => client.close()));
    },
  };
}

it.each([
  "completion",
  "cancel",
  "cancel-fallback",
  "revoke",
  "deadline",
  "foreign",
  "foreign-deadline",
])(
  "settles every repeated reverse waiter on %s",
  async (cause) => {
    const f = await sharedFixture();
    const bus =
      cause.startsWith("foreign") || cause === "cancel-fallback"
        ? vi.spyOn(changes, "subscribe").mockImplementation(() => () => {})
        : undefined;
    if (cause === "foreign-deadline")
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const one = await f.call();
      await until(() => pendingReverseCalls(f.owner, f.peerId).length === 1);
      const row = pendingReverseCalls(f.owner, f.peerId)[0];
      // Register the second waiter synchronously at the same production boundary;
      // revocation must not race an HTTP request that has not authenticated yet.
      const two = {
        answer: waitForReverseCall(f.owner, row.id).catch((error: Error) => ({
          error: error.message,
        })),
      };
      const at = Date.now();
      if (cause === "completion") {
        completeReverseCall(f.owner, f.peerId, row.id, "completed", {
          content: [{ type: "text", text: "one result" }],
        });
        completeReverseCall(f.owner, f.peerId, row.id, "completed", {
          content: [{ type: "text", text: "one result" }],
        });
      } else if (["cancel", "cancel-fallback"].includes(cause)) {
        const response = await fetch(
          `http://127.0.0.1:${config.port}/runs/${f.run.id}/cancel`,
          { method: "POST", headers: { "x-owner": f.owner } },
        );
        expect(response.status).toBe(200);
      } else if (cause === "revoke") revokeFederationPeer(f.owner, f.peerId);
      else if (cause.startsWith("foreign")) {
        const foreign = new Database(join(dir, "loop.db"));
        try {
          foreign
            .prepare(
              "UPDATE mcp_reverse_calls SET state='completed',result=? WHERE id=?",
            )
            .run(
              JSON.stringify({
                content: [{ type: "text", text: "one result" }],
              }),
              row.id,
            );
        } finally {
          foreign.close();
        }
      }
      const [a, b] = await Promise.all([one.answer, two.answer]);
      if (cause === "completion" || cause.startsWith("foreign")) {
        expect(a).toMatchObject({ content: [{ text: "one result" }] });
        expect(b).toEqual(a);
        expect(await (await f.call()).answer).toEqual(a);
      } else {
        expect(JSON.stringify(a)).toContain("uncertain");
        expect(JSON.stringify(b)).toContain("uncertain");
        expect(
          db
            .prepare("SELECT state FROM mcp_reverse_calls WHERE id=?")
            .get(row.id),
        ).toEqual({ state: "unknown" });
      }
      expect(Date.now() - at).toBeLessThan(
        ["deadline", "foreign-deadline"].includes(cause)
          ? 3400
          : ["foreign", "cancel-fallback"].includes(cause)
            ? 2300
            : 700,
      );
      expect(
        db
          .prepare("SELECT count(*) n FROM mcp_reverse_calls WHERE run_key=?")
          .get(f.run.id),
      ).toEqual({ n: 1 });
    } finally {
      bus?.mockRestore();
      await f.close();
      vi.useRealTimers();
    }
  },
  10000,
);

it("sees a reverse completion committed before waiter registration", async () => {
  const f = await sharedFixture();
  const key = id();
  db.prepare(
    "INSERT INTO mcp_reverse_calls(id,owner_id,peer_id,run_key,request_key,tool_name,args,state,created_at,updated_at) VALUES(?,?,?,?,?,'tool','{}','pending',0,0)",
  ).run(key, f.owner, f.peerId, f.run.id, "before-register");
  completeReverseCall(f.owner, f.peerId, key, "completed", {
    content: [{ type: "text", text: "already durable" }],
  });
  try {
    expect(await waitForReverseCall(f.owner, key)).toEqual({
      content: [{ type: "text", text: "already durable" }],
    });
  } finally {
    await f.close();
  }
});

it("settles an orphaned reverse call after its run is removed", async () => {
  const f = await sharedFixture();
  const key = id();
  db.prepare(
    "INSERT INTO mcp_reverse_calls(id,owner_id,peer_id,run_key,request_key,tool_name,args,state,created_at,updated_at) VALUES(?,?,?,?,?,'tool','{}','pending',0,0)",
  ).run(key, f.owner, f.peerId, f.run.id, "removed-run");
  db.prepare("DELETE FROM runs WHERE id=?").run(f.run.id);
  try {
    await expect(waitForReverseCall(f.owner, key)).rejects.toThrow("uncertain");
  } finally {
    await f.close();
  }
});

it("commits a reverse result and notification before a competing run deletion", async () => {
  const f = await sharedFixture();
  const foreign = new Database(join(dir, "loop.db"), { timeout: 20 });
  const prepare = db.prepare.bind(db);
  let attempted = false,
    deletion = "not attempted";
  const hook = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
    const statement = prepare(sql);
    if (sql === "SELECT 1 FROM runs WHERE id=? AND owner_id=?") {
      const get = statement.get.bind(statement);
      statement.get = ((...args: any[]) => {
        const row = get(...args);
        if (row && !attempted) {
          attempted = true;
          try {
            foreign.prepare("DELETE FROM runs WHERE id=?").run(f.run.id);
            deletion = "deleted";
          } catch (error) {
            deletion = (error as { code: string }).code;
          }
        }
        return row;
      }) as typeof statement.get;
    }
    return statement;
  }) as typeof db.prepare);
  try {
    const { answer } = await f.call();
    await until(() => pendingReverseCalls(f.owner, f.peerId).length === 1);
    const call = pendingReverseCalls(f.owner, f.peerId)[0];
    const result = { content: [{ type: "text", text: "known completion" }] };
    expect(
      completeReverseCall(f.owner, f.peerId, call.id, "completed", result),
    ).toEqual({ state: "completed" });
    expect(attempted).toBe(true);
    expect(deletion).toBe("SQLITE_BUSY");
    expect(await answer).toMatchObject(result);
    // Once committed, deletion and a repeated completion are both safe.
    foreign.prepare("DELETE FROM runs WHERE id=?").run(f.run.id);
    expect(
      completeReverseCall(f.owner, f.peerId, call.id, "completed", result),
    ).toEqual({ state: "completed" });
    expect(await waitForReverseCall(f.owner, call.id)).toEqual(result);
  } finally {
    hook.mockRestore();
    foreign.close();
    await f.close();
  }
});
