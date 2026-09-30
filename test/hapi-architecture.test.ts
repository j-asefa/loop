import { afterAll, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
const dir = mkdtempSync(join(tmpdir(), "loop-hapi-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { provisionEnvironment } =
  await import("../src/server/hapi/environments");
const { billingPolicy, verifyAuth, connectionSelection } =
  await import("../src/server/hapi/contracts");
const { ensureSession, projectMessages, normalizeMessage } =
  await import("../src/server/hapi/adapter");
const { HapiClient } = await import("../src/server/hapi/client");
const { submit } = await import("../src/server/agent-runtime");
const { createAgent } = await import("../src/server/domain");
const { claim, recoverStale } = await import("../src/server/queue");
const { gatewayContext } = await import("../src/server/hapi/gateway");
const { unseal } = await import("../src/server/secrets");
const { captureMemory, searchMemory, readMemory, recallForRun } =
  await import("../src/server/memory");
const host = provisionEnvironment("alice", {
  name: "Test environment fixture",
  url: "https://worker.invalid:3010",
  instanceId: "i-1234567890abcdef0",
  namespace: "alice-fixture",
  credential: "a".repeat(48),
  certificateFingerprint: "AB:".repeat(31) + "AB",
});
const project = id();
db.prepare(
  "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES(?,'alice','project','HAPI fixtures',?)",
).run(project, now());
const connection = id();
db.prepare(
  "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,'alice','codex','HAPI fixture','','connected','[{\"id\":\"fixture\"}]',?,?)",
).run(
  connection,
  JSON.stringify({
    backend: "hapi",
    environmentId: host,
    flavor: "codex",
    billing: billingPolicy,
  }),
  now(),
);
const agent = createAgent("alice", {
  name: "hapi-fixture",
  connectionId: connection,
  model: "fixture",
});
db.prepare("UPDATE agents SET folder_id=? WHERE id=?").run(project, agent.id);
const run = submit("alice", {
  agentId: agent.id,
  input: "We chose SQLite WAL for durable queue state.",
  idempotencyKey: "native-first",
});
const session = ensureSession(run);
const localId = id();
db.prepare(
  "INSERT INTO native_dispatches(run_id,conversation_id,local_id,payload_hash,envelope,billing,environment_id,generation,state,created_at,updated_at) VALUES(?,?,?,'hash','injected historical envelope',?,?,1,'accepted',?,?)",
).run(
  run.id,
  run.conversation_id,
  localId,
  JSON.stringify(billingPolicy),
  host,
  now(),
  now(),
);
db.prepare("UPDATE runs SET state='running' WHERE id=?").run(run.id);
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
describe("HAPI architecture safety (deterministic protocol fixtures)", () => {
  it("requires verified fresh native ChatGPT auth and rejects API, missing, expired and unknown evidence", () => {
    const base = {
      authenticated: true,
      managed: true,
      checkedAt: Date.now(),
      authMethod: "chatgpt",
    };
    expect(() => verifyAuth("codex", base)).not.toThrow();
    for (const value of [
      { ...base, authMethod: "apiKey" },
      { ...base, authMethod: "unknown" },
      { ...base, authenticated: false },
      { ...base, managed: false },
      { ...base, checkedAt: 0 },
      null,
    ])
      expect(() => verifyAuth("codex", value)).toThrow();
    expect(() =>
      connectionSelection({
        metadata: JSON.stringify({
          backend: "hapi",
          environmentId: host,
          flavor: "codex",
          billing: { ...billingPolicy, allowApiFallback: true },
        }),
      }),
    ).toThrow();
  });
  it("preserves billing and conversation backend across subsequent submissions", () => {
    const next = submit("alice", {
      agentId: agent.id,
      conversationId: run.conversation_id!,
      input: "Continue the same thread",
      idempotencyKey: "native-second",
    });
    expect(JSON.parse(next.payload).execution.billing).toEqual(billingPolicy);
    expect(ensureSession(next).launch_id).toBe(session.launch_id);
    expect(
      submit("alice", {
        agentId: agent.id,
        input: run.input,
        idempotencyKey: "native-first",
      }).id,
    ).toBe(run.id);
  });
  it("uses session identity for gateway access, blocks cross-environment access and requires a unique active turn", () => {
    const secret = unseal(session.gateway_secret, "alice");
    expect(gatewayContext(secret, host).run.id).toBe(run.id);
    expect(() => gatewayContext(secret, "another-environment")).toThrow();
    expect(() => gatewayContext("wrong", host)).toThrow();
  });
  it("does not requeue externally executing work after an application lease expires", () => {
    db.prepare("UPDATE runs SET worker_id='dead',heartbeat=? WHERE id=?").run(
      now() - 120000,
      run.id,
    );
    recoverStale();
    expect(
      (db.prepare("SELECT state FROM runs WHERE id=?").get(run.id) as any)
        .state,
    ).toBe("running");
  });
  it("does not complete a run from terminal text or duplicate a REST user echo", () => {
    const messages = [
      {
        id: "user-echo",
        localId,
        invokedAt: 100,
        createdAt: 99,
        content: {
          role: "user",
          content: { type: "text", text: "injected historical envelope" },
        },
      },
      {
        id: "terminal-output",
        createdAt: 101,
        content: {
          role: "agent",
          content: {
            type: "codex",
            data: { type: "message", message: "Terminal-origin work" },
          },
        },
      },
    ];
    projectMessages(session, messages, 1, { seq: 2, at: 101 });
    projectMessages(session, messages, 1, { seq: 2, at: 101 });
    expect(
      (
        db
          .prepare(
            "SELECT count(*) n FROM messages WHERE conversation_id=? AND role='user'",
          )
          .get(run.conversation_id) as any
      ).n,
    ).toBe(2);
    expect(
      (db.prepare("SELECT state FROM runs WHERE id=?").get(run.id) as any)
        .state,
    ).toBe("running");
    expect(normalizeMessage(messages[1]).content).toBe("Terminal-origin work");
  });
  it("completes exactly one Loop projection only from correlated native completion", () => {
    const body = {
      type: "loop-turn",
      localId,
      threadId: "native-thread-1",
      turnId: "native-turn-1",
      status: "completed",
      output: "SQLite WAL was selected.",
    };
    const event = {
      id: "completion",
      createdAt: 200,
      content: { role: "agent", content: { type: "codex", data: body } },
    };
    projectMessages(session, [event], 1, { seq: 3, at: 200 });
    projectMessages(session, [event], 1, { seq: 3, at: 200 });
    expect(
      (db.prepare("SELECT state FROM runs WHERE id=?").get(run.id) as any)
        .state,
    ).toBe("completed");
    expect(
      (
        db
          .prepare("SELECT count(*) n FROM artifacts WHERE run_id=?")
          .get(run.id) as any
      ).n,
    ).toBe(1);
  });
  it("keeps memory scoped, cites original text, and rejects exclusion/tombstones even with stale semantic hits", async () => {
    captureMemory();
    const sources = db
      .prepare(
        "SELECT * FROM memory_sources WHERE owner_id='alice' AND role='user'",
      )
      .all() as any[];
    const source = sources.find((s) => s.content.includes("SQLite"));
    expect(source.content).not.toContain("injected historical envelope");
    const fake = {
      async request() {
        return {
          results: [{ id: source.id, revision: source.revision, score: 1 }],
        };
      },
    };
    expect(
      (await searchMemory("alice", project, "durable queue", fake)).sources[0]
        .link,
    ).toContain("message=");
    expect(
      (await searchMemory("bob", project, "durable queue", fake)).sources,
    ).toEqual([]);
    expect(
      (await searchMemory("alice", "different-project", "durable queue", fake))
        .sources,
    ).toEqual([]);
    db.prepare("INSERT INTO memory_policy VALUES('alice',?,0)").run(
      "conversation:" + run.conversation_id,
    );
    expect(
      (await searchMemory("alice", project, "durable queue", fake)).sources,
    ).toEqual([]);
    expect(() => readMemory("alice", source.id)).toThrow();
    db.prepare(
      "UPDATE memory_policy SET enabled=1 WHERE owner_id='alice'",
    ).run();
    db.prepare("UPDATE memory_sources SET tombstone=1 WHERE id=?").run(
      source.id,
    );
    captureMemory();
    expect(
      (await searchMemory("alice", project, "durable queue", fake)).sources.map(
        (s) => s.id,
      ),
    ).not.toContain(source.id);
  });
  it("normalizes pinned Claude output and excludes transcript echoes from capture", () => {
    const message = {
      id: "claude-output",
      createdAt: 300,
      content: {
        role: "agent",
        content: {
          type: "output",
          data: {
            type: "assistant",
            message: {
              content: [
                { type: "text", text: "The selected database is SQLite." },
                { type: "thinking", thinking: "private reasoning" },
              ],
            },
          },
        },
      },
    };
    expect(normalizeMessage(message).content).toBe(
      "The selected database is SQLite.",
    );
    expect(normalizeMessage(message).role).toBe("assistant");
    const echo = {
      id: "claude-echo",
      createdAt: 301,
      content: {
        role: "user",
        content: { type: "text", text: "Historical evidence injected by Loop" },
        meta: { isTranscriptEcho: true },
      },
    };
    projectMessages(session, [echo], 1, { seq: 4, at: 301 });
    expect(
      db
        .prepare("SELECT 1 FROM messages WHERE content=?")
        .get("Historical evidence injected by Loop"),
    ).toBeUndefined();
  });
  it("reactivates identical authoritative messages after history invalidation without deleting old content", () => {
    const m = {
      id: "history-reset",
      createdAt: 302,
      content: {
        role: "agent",
        content: {
          type: "codex",
          data: { type: "message", message: "Retained history" },
        },
      },
    };
    projectMessages(session, [m], 1, { seq: 5, at: 302 });
    db.prepare(
      "UPDATE messages SET metadata=json_set(metadata,'$.superseded',json('true')) WHERE content='Retained history'",
    ).run();
    projectMessages(session, [m], 2, { seq: 5, at: 302 }, false);
    const row = db
      .prepare("SELECT metadata FROM messages WHERE content='Retained history'")
      .get() as any;
    expect(JSON.parse(row.metadata).superseded).toBeUndefined();
  });
  it("persists environment provisioning identity idempotently and refuses a substituted instance", () => {
    expect(
      provisionEnvironment("alice", {
        name: "Test environment fixture",
        url: "https://worker.invalid:3010",
        instanceId: "i-1234567890abcdef0",
        namespace: "alice-fixture",
        credential: "a".repeat(48),
        certificateFingerprint: "AB:".repeat(31) + "AB",
      }),
    ).toBe(host);
    expect(() =>
      provisionEnvironment("alice", {
        name: "substitute",
        url: "https://worker.invalid:3010",
        instanceId: "i-aaaaaaaaaaaaaaaaa",
        namespace: "alice-fixture",
        credential: "a".repeat(48),
        certificateFingerprint: "AB:".repeat(31) + "AB",
      }),
    ).toThrow(/another identity/);
  });
  it('preserves tombstones and uncertain receipts through a SQLite backup restore',async()=>{
    const path=join(dir,'restore.db');await db.backup(path);
    const Database=(await import('better-sqlite3')).default;const restored=new Database(path);
    expect((restored.prepare('PRAGMA integrity_check').get() as any).integrity_check).toBe('ok');
    expect((restored.prepare('SELECT count(*) n FROM memory_sources WHERE tombstone=1').get() as any).n).toBeGreaterThan(0);
    expect(restored.prepare('SELECT local_id,billing FROM native_dispatches WHERE run_id=?').get(run.id)).toEqual(db.prepare('SELECT local_id,billing FROM native_dispatches WHERE run_id=?').get(run.id));restored.close();
  });
  it("does not retry a mutation when its acknowledgement is lost; rejects HTTP-200 structured spawn failure", async () => {
    let sent = 0;
    const fake = async (url: any, options: any) => {
      if (String(url).endsWith("/api/auth"))
        return Response.json({ token: "fixture" });
      sent++;
      throw new Error("Connection lost after acceptance");
    };
    const client = new HapiClient("http://fixture", "fixture", fake as any);
    await expect(
      client.request("/api/sessions/s/messages", {
        localId: "stable",
        text: "write",
      }),
    ).rejects.toThrow();
    expect(sent).toBe(1);
    const denied = new HapiClient("http://fixture", "fixture", (async (
      url: any,
    ) =>
      Response.json(
        String(url).endsWith("/api/auth")
          ? { token: "fixture" }
          : { type: "error", message: "denied" },
      )) as any);
    await expect(denied.request("/api/machines/m/spawn", {})).rejects.toThrow(
      /reconcile/,
    );
  });
  it("keeps offline environment work queued without claiming it", () => {
    expect(claim("test-worker")).toBeUndefined();
    const next = db
      .prepare("SELECT * FROM runs WHERE idempotency_key='native-second'")
      .get() as any;
    expect(next.state).toBe("queued");
  });
});
