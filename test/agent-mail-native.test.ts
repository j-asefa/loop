import express from "express";
import { until } from "./helpers";
import { createHash } from "node:crypto";
import { afterAll, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { gitProject } from "./git-project";
const dir = realpathSync(mkdtempSync(join(tmpdir(), "loop-mail-native-")));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_PROFILE = "companion";
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
process.env.LOOP_TEST_HARNESS = "codex";
process.env.LOOP_TEST_AGENT_MAIL = "1";
gitProject(dir);
const { db, id, now, changes } = await import("../src/server/db");
const { createAgent } = await import("../src/server/domain");
const { seal } = await import("../src/server/secrets");
const { submit, executeAgent } = await import("../src/server/agent-runtime");
const { claim, transition } = await import("../src/server/queue");
const { nativeSessions } = await import("../src/server/native-sessions");
const { NativeToolBridge } = await import("../src/server/native-tool-bridge");
const { withTestAdapter } = await import("../src/server/providers");
const { agentMessages, sendMail } = await import("../src/server/agent-mail");
const { createTeam } = await import("../src/server/teams");
const { tick } = await import("../src/server/worker");
const bridge = new NativeToolBridge();
await bridge.start();
let ticket: { url: string; token: string };
nativeSessions.tools = (conversation, generation) =>
  (ticket = bridge.issue(conversation, generation));
nativeSessions.revokeTools = (conversation, generation) =>
  bridge.revoke(conversation, generation);
afterAll(async () => {
  await nativeSessions.close();
  await bridge.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

it("does not transfer refused mail into a newly selected native harness", async () => {
  const owner = "refused-native-context",
    apiConnection = id(),
    nativeConnection = id();
  for (const [cid, metadata] of [
    [apiConnection, {}],
    [nativeConnection, { loopHarness: "codex" }],
  ] as const)
    db.prepare(
      "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,?,'openai','Fixture',?,'connected',?,?,?)",
    ).run(
      cid,
      owner,
      seal("fixture", owner),
      JSON.stringify([{ id: "fixture" }]),
      JSON.stringify(metadata),
      now(),
    );
  db.prepare(
    "INSERT OR IGNORE INTO harnesses VALUES('codex',?,'{}','{}','[]',0)",
  ).run(
    JSON.stringify({
      harness: "codex",
      executable: resolve("test/harness.mjs"),
      project: dir,
      billing: "existing",
      version: "fixture",
    }),
  );
  const sender = createAgent(owner, {
    name: "context-sender",
    model: "fixture",
    connectionId: apiConnection,
  });
  const recipient = createAgent(owner, {
    name: "context-recipient",
    model: "fixture",
    connectionId: apiConnection,
  });
  const team = createTeam(owner, {
    name: "Context",
    managerId: sender.id,
    members: [recipient.id],
  });
  const source = submit(owner, {
    agentId: sender.id,
    conversationId: team.conversation_id!,
    input: "Send a message",
    idempotencyKey: id(),
  });
  const active = claim("source", (r) => r.id === source.id)!;
  const receipt = sendMail(active, "refused", {
    to: recipient.id,
    body: "UNDELIVERED_NATIVE_CONTEXT",
  });
  const mail = db
    .prepare("SELECT * FROM agent_mail WHERE id=?")
    .get(receipt.messageId) as {
    run_id: string;
    recipient_conversation_id: string;
  };
  db.prepare("DELETE FROM team_members WHERE team_id=? AND agent_id=?").run(
    team.id,
    recipient.id,
  );
  expect(claim("refuse", (r) => r.id === mail.run_id)).toBeUndefined();
  expect(
    db
      .prepare("SELECT state FROM agent_mail WHERE id=?")
      .get(receipt.messageId),
  ).toEqual({ state: "refused" });
  transition(active, "completed");
  db.prepare("UPDATE agents SET connection_id=? WHERE id=?").run(
    nativeConnection,
    recipient.id,
  );
  const next = submit(owner, {
    agentId: recipient.id,
    conversationId: mail.recipient_conversation_id,
    input: "A new user request",
    idempotencyKey: id(),
  });
  const run = claim("native", (r) => r.id === next.id)!;
  expect(await executeAgent(run)).toBe(true);
  transition(run, "completed");
  const binding = db
    .prepare(
      "SELECT instructions FROM companion_sessions WHERE conversation_id=?",
    )
    .get(mail.recipient_conversation_id) as { instructions: string };
  expect(binding.instructions).not.toContain("UNDELIVERED_NATIVE_CONTEXT");
});

it("a solo API agent discovers and questions a solo native agent, whose bridge reply returns to the original conversation", async () => {
  const owner = "local-workspace";
  const apiConnection = id(),
    nativeConnection = id();
  for (const [cid, metadata] of [
    [apiConnection, {}],
    [nativeConnection, { loopHarness: "codex" }],
  ] as const)
    db.prepare(
      "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,?,'openai','Fixture',?,'connected',?,?,?)",
    ).run(
      cid,
      owner,
      seal("fixture", owner),
      JSON.stringify([{ id: "fixture" }]),
      JSON.stringify(metadata),
      now(),
    );
  db.prepare(
    "INSERT OR IGNORE INTO harnesses VALUES('codex',?,'{}','{}','[]',0)",
  ).run(
    JSON.stringify({
      harness: "codex",
      executable: resolve("test/harness.mjs"),
      project: dir,
      billing: "existing",
      version: "fixture",
    }),
  );
  const api = createAgent(owner, {
    name: "api-agent",
    model: "fixture",
    connectionId: apiConnection,
  });
  const native = createAgent(owner, {
    name: "native-agent",
    model: "fixture",
    connectionId: nativeConnection,
  });
  const restore = withTestAdapter("openai", {
    async models() {
      return [];
    },
    async *stream(_key, input) {
      const last = input.messages.findLast((m) => m.role === "user")!.content;
      if (last.includes("Native reply:")) {
        yield {
          text: "Received the native answer in my original conversation.",
        };
        return;
      }
      const results = input.messages.filter((m) => m.role === "tool");
      if (!results.length)
        yield {
          toolCall: {
            id: "discover",
            name: "loop_agents",
            arguments: { query: "native" },
          },
        };
      else if (results.length === 1) {
        expect(results[0].content).toContain(native.id);
        yield {
          toolCall: {
            id: "question",
            name: "loop_message",
            arguments: { to: native.id, body: "Which version?" },
          },
        };
      } else yield { text: "Question sent; finishing my turn." };
    },
  });
  try {
    const original = submit(owner, {
      agentId: api.id,
      input: "Ask the native agent",
      idempotencyKey: "start",
    });
    for (let step = 0; step < 3; step++) {
      const run = claim("worker-" + step)!;
      expect(run).toBeDefined();
      expect(await executeAgent(run)).toBe(true);
      transition(run, "completed");
    }
    const mail = db
      .prepare("SELECT * FROM agent_mail WHERE owner_id=? ORDER BY rowid")
      .all(owner) as any[];
    expect(mail).toHaveLength(2);
    expect(mail[1]).toMatchObject({
      sender_agent_id: native.id,
      recipient_agent_id: api.id,
      recipient_conversation_id: original.conversation_id,
    });
    expect(mail[1].thread_id).toBe(mail[0].thread_id);
    expect(
      db.prepare("SELECT result FROM runs WHERE id=?").get(mail[1].run_id),
    ).toEqual({
      result: "Received the native answer in my original conversation.",
    });
    expect(
      agentMessages(owner, api.id).threads[0].messages.map((m) => m.status),
    ).toEqual(["handled", "handled"]);
    expect(db.prepare("SELECT count(*) n FROM teams WHERE owner_id=?").get(owner)).toEqual({ n: 0 });
    // The private bridge refuses a missing credential and cannot revive a finished run.
    const request = {
      method: "tools/call",
      id: "late",
      name: "loop_message",
      arguments: { to: api.id, body: "late" },
    };
    expect(
      (
        await fetch(ticket.url + "/pi", {
          method: "POST",
          body: JSON.stringify(request),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(ticket.url + "/pi", {
          method: "POST",
          headers: { authorization: "Bearer " + ticket.token },
          body: JSON.stringify(request),
        })
      ).status,
    ).toBe(409);
    expect(db.prepare("SELECT count(*) n FROM agent_mail WHERE owner_id=?").get(owner)).toEqual({
      n: 2,
    });
    const source = submit(owner, {
      agentId: api.id,
      input: "Next question",
      conversationId: original.conversation_id!,
      idempotencyKey: "second-question",
    });
    db.prepare("UPDATE runs SET state='running' WHERE id=?").run(source.id);
    const accepted = sendMail(source, "disconnect-race", {
      to: native.id,
      body: "Check again",
    });
    transition(source, "completed");
    const recipient = (
      db
        .prepare("SELECT run_id FROM agent_mail WHERE id=?")
        .get(accepted.messageId) as { run_id: string }
    ).run_id;
    // Change availability after claim, at the real worker/executor boundary.
    await tick(async (run) => {
      expect(run.id).toBe(recipient);
      db.prepare("UPDATE connections SET status='disconnected' WHERE id=?").run(
        nativeConnection,
      );
      return executeAgent(run);
    });
    expect(
      db.prepare("SELECT state FROM runs WHERE id=?").get(recipient),
    ).toEqual({ state: "queued" });
    expect(
      db.prepare("SELECT 1 FROM native_dispatch WHERE run_id=?").get(recipient),
    ).toBeUndefined();
    db.prepare("UPDATE connections SET status='connected' WHERE id=?").run(
      nativeConnection,
    );
    await tick(executeAgent);
    await tick(executeAgent);
    expect(
      db.prepare("SELECT state FROM runs WHERE id=?").get(recipient),
    ).toEqual({ state: "completed" });
    expect(
      db
        .prepare("SELECT count(*) n FROM runs WHERE idempotency_key=?")
        .get(`mail:${source.id}:disconnect-race`),
    ).toEqual({ n: 1 });
  } finally {
    restore();
  }
}, 20000);


it.each(["approval", "approval-fallback", "child", "child-fallback", "cancel", "cancel-fallback", "expiry", "concurrent-expiry"])(
  "wakes a native bridge call on %s without replay", async (cause) => {
    const owner = "local-workspace", connection = id();
    db.prepare("INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,?,'openai','Signal native','','connected',?,?,0)")
      .run(connection, owner, JSON.stringify([{ id: "fixture" }]), JSON.stringify({ loopHarness: "codex" }));
    const manager = createAgent(owner, { name: "signal-" + id().slice(0, 8), model: "fixture", connectionId: connection });
    const childAgent = createAgent(owner, { name: "child-" + id().slice(0, 8), model: "fixture", connectionId: connection });
    const team = createTeam(owner, { name: "Signal", managerId: manager.id, members: [childAgent.id] });
    const submitted = submit(owner, { agentId: manager.id, teamId: team.id, conversationId: team.conversation_id!, input: "wait", idempotencyKey: id() });
    const run = claim("bridge-signal", (candidate) => candidate.id === submitted.id)!;
    const bus = cause.endsWith("fallback") ? vi.spyOn(changes, "subscribe").mockImplementation(() => () => {}) : undefined;
    const { core } = await import("../src/server/core-routes");
    const app = express();
    app.use(express.json(), (_req, res, next) => { res.locals.owner = owner; next(); });
    app.use(core);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { withTestMcp } = await import("../src/server/mcp/client");
    const { setMcpApprovalMode } = await import("../src/server/mcp/approval-policy");
    const { decide } = await import("../src/server/approvals");
    setMcpApprovalMode(owner, "ask");
    const mcpId = id();
    db.prepare("INSERT INTO mcp_connections(id,owner_id,name,url,secret,status,tools,metadata,created_at) VALUES(?,?,'Signal MCP','https://fixture.example/mcp',?,'connected',?,'{}',0)")
      .run(mcpId, owner, seal('{"type":"none"}', owner), JSON.stringify([{ name: "lookup", description: "Signal fixture", inputSchema: { type: "object" } }]));
    let calls = 0;
    const restore = withTestMcp(async () => ({
      async callTool() { calls++; return { content: [{ type: "text", text: "approved result" }] }; },
      async close() {},
    }) as any);
    const work = executeAgent(run);
    try {
      await until(() => (db.prepare("SELECT state FROM native_dispatch WHERE run_id=?").get(run.id) as any)?.state === "accepted");
      const endpoint = { ...ticket };
      const call = async (body: object) => (await fetch(endpoint.url + "/pi", { method: "POST", headers: { authorization: "Bearer " + endpoint.token }, body: JSON.stringify(body) })).json();
      await call({ method: "tools/list" });
      const concurrentExpiry = cause === "concurrent-expiry";
      if (cause === "expiry" || concurrentExpiry) db.exec(`CREATE TEMP TRIGGER short_bridge_approval AFTER INSERT ON approvals WHEN NEW.run_id='${run.id}' BEGIN UPDATE approvals SET expires_at=NEW.created_at+200 WHERE id=NEW.id; END`);
      const child = cause.startsWith("child") || concurrentExpiry;
      const mcpName = "loop_mcp_" + createHash("sha256").update(mcpId + ":lookup").digest("hex").slice(0, 20);
      const request = { method: "tools/call", id: "signal-call", name: child ? "loop_delegate" : mcpName, arguments: child ? { tasks: [{ agentId: childAgent.id, input: "Check" }] } : {} };
      const answer = call(request);
      let approval: { id: string } | undefined;
      await until(() => child
        ? !!db.prepare("SELECT 1 FROM delegations WHERE parent_run_id=?").get(run.id)
        : !!(approval = db.prepare("SELECT id FROM approvals WHERE run_id=?").get(run.id) as { id: string } | undefined));
      const at = Date.now();
      if (concurrentExpiry) {
        // Another request's approval must not permanently cache an expiry error
        // for the delegation that was already waiting on its child.
        const expired = await call({ method: "tools/call", id: "expiring-call", name: mcpName, arguments: {} });
        expect(expired.isError).toBe(true);
        expect(JSON.stringify(expired)).toContain("expired");
        const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/runs/${run.id}/cancel`, { method: "POST" });
        expect(response.status).toBe(200);
      } else if (child) {
        const childId = (db.prepare("SELECT child_run_id FROM delegations WHERE parent_run_id=?").get(run.id) as { child_run_id: string }).child_run_id;
        const childRun = claim("bridge-child", (candidate) => candidate.id === childId)!;
        expect(childRun).toBeDefined();
        db.prepare("UPDATE runs SET result='child result' WHERE id=?").run(childId);
        transition(childRun, "completed");
      } else if (cause.startsWith("cancel")) {
        const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/runs/${run.id}/cancel`, { method: "POST" });
        expect(response.status).toBe(200);
      } else if (cause !== "expiry") decide(owner, approval!.id, "approve");
      const result = await answer;
      expect(Date.now() - at).toBeLessThan(cause.endsWith("fallback") ? 2300 : 700);
      if (cause === "expiry" || cause.startsWith("cancel") || concurrentExpiry) {
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).toContain(cause === "expiry" ? "expired" : "cancelled");
        expect(calls).toBe(0);
      } else {
        expect(result.isError).not.toBe(true);
        expect(JSON.stringify(result)).toContain(child ? "child result" : "approved result");
        expect(await call(request)).toEqual(result);
        expect(calls).toBe(child ? 0 : 1);
      }
    } finally {
      db.exec("DROP TRIGGER IF EXISTS short_bridge_approval");
      transition(run, "cancelled");
      await nativeSessions.interrupt(run.id);
      await work;
      bus?.mockRestore();
      restore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 10000,
);
