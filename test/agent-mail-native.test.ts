import { afterAll, expect, it } from "vitest";
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
const { db, id, now } = await import("../src/server/db");
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
