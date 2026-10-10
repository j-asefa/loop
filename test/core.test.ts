import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
const dir = mkdtempSync(join(tmpdir(), "loop-core-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { seal, unseal } = await import("../src/server/secrets");
const { createAgent, renameAgent, owned } =
  await import("../src/server/domain");
const { submit, executeAgent } = await import("../src/server/agent-runtime");
const { claim, transition } = await import("../src/server/queue");
const { withTestAdapter } = await import("../src/server/providers");
const calls: any[] = [];
const restore = withTestAdapter("openai", {
  async models() {
    return [
      { id: "fixture-model", name: "Fixture model", capabilities: "Test only" },
    ];
  },
  async *stream(_secret, input) {
    calls.push(input);
    yield { text: "Verified " };
    yield { text: "fixture response." };
    yield { usage: { input_tokens: 10, output_tokens: 5 } };
  },
});
function connection(owner: string) {
  const c = id();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,?,'openai','Test fixture',?,'connected',?,?)",
  ).run(
    c,
    owner,
    seal("fake-key", owner),
    JSON.stringify([{ id: "fixture-model" }]),
    now(),
  );
  return c;
}
afterAll(() => {
  restore();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
describe("durable agent contract", () => {
  it("reserves case-folded handles across users and keeps renamed handles reserved", () => {
    const a = createAgent("alice", {
      name: "Scout-test",
      connectionId: connection("alice"),
      model: "fixture-model",
    });
    expect(() =>
      createAgent("bob", {
        name: "SCOUT-test",
        connectionId: connection("bob"),
        model: "fixture-model",
      }),
    ).toThrow(/taken/);
    renameAgent("alice", a.id, "renamed-scout");
    expect(() =>
      createAgent("bob", {
        name: "scout-test",
        connectionId: connection("bob"),
        model: "fixture-model",
      }),
    ).toThrow(/taken/);
    expect(() => owned("agents", a.id, "bob")).toThrow("Item not found");
    expect(owned<any>("agents", a.id, "alice").id).toBe(a.id);
  });
  it("binds selected model, retains prior history, prevents duplicate retries, and saves final artifacts", async () => {
    const a = createAgent("alice", {
      name: "researcher-test",
      connectionId: connection("alice"),
      model: "fixture-model",
      instructions: "Be precise",
    });
    const first = submit("alice", {
      agentId: a.id,
      input: "First idea",
      idempotencyKey: "first-idempotency-key",
    });
    expect(
      submit("alice", {
        agentId: a.id,
        input: "First idea",
        idempotencyKey: "first-idempotency-key",
      }).id,
    ).toBe(first.id);
    expect(() =>
      submit("alice", {
        agentId: a.id,
        input: "Different",
        idempotencyKey: "first-idempotency-key",
      }),
    ).toThrow();
    const second = submit("alice", {
      agentId: a.id,
      conversationId: first.conversation_id!,
      input: "Go for it",
      idempotencyKey: "second-idempotency-key",
    });
    const run = claim("test-worker")!;
    expect(run.id).toBe(first.id);
    expect(claim("second-worker")).toBeUndefined();
    await executeAgent(run);
    transition(run, "completed");
    const next = claim("second-worker")!;
    expect(next.id).toBe(second.id);
    await executeAgent(next);
    transition(next, "completed");
    expect(calls.at(-1).model).toBe("fixture-model");
    expect(calls.at(-1).messages.map((m: any) => m.content)).toEqual([
      "First idea",
      "Verified fixture response.",
      "Go for it",
    ]);
    expect(
      db.prepare("SELECT count(*) n FROM artifacts WHERE agent_id=?").get(a.id),
    ).toEqual({ n: 2 });
    expect(
      db
        .prepare("SELECT count(*) n FROM messages WHERE conversation_id=? AND update_key IS NULL")
        .get(first.conversation_id),
    ).toEqual({ n: 4 });
  });
  it("authenticates ciphertext against the owner and never accepts another user’s connection", () => {
    const c = connection("alice");
    expect(() =>
      createAgent("bob", {
        name: "wrong-owner",
        connectionId: c,
        model: "fixture-model",
      }),
    ).toThrow("Item not found");
    expect(unseal(seal("key", "alice"), "alice")).toBe("key");
    expect(() => unseal(seal("key", "alice"), "bob")).toThrow();
  });
});

it("serializes native turns per conversation while allowing the same agent's other conversations", async () => {
  const connectionId = connection("native-owner");
  const agent = createAgent("native-owner", {
    name: "native-queue",
    connectionId,
    model: "fixture-model",
  });
  const { enqueue } = await import("../src/server/queue");
  const conversation = () => {
    const cid = id();
    db.prepare(
      "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,'test',?)",
    ).run(cid, "native-owner", agent.id, now());
    return cid;
  };
  db.prepare("UPDATE connections SET metadata=? WHERE id=?").run(
    JSON.stringify({ loopHarness: "codex" }),
    connectionId,
  );
  const firstConversation = conversation();
  const make = (cid: string) =>
    enqueue("native-owner", "test", id(), {
      agent: agent.id,
      conversation: cid,
      payload: { connectionId },
    });
  const first = make(firstConversation);
  const follow = make(firstConversation);
  const other = make(conversation());
  const active = claim("native-first")!;
  expect(active.id).toBe(first.id);
  expect(claim("native-other")?.id).toBe(other.id);
  expect(claim("native-blocked")).toBeUndefined();
  transition(active, "completed");
  expect(claim("native-follow")?.id).toBe(follow.id);
  transition(follow, "completed");
  transition(other, "completed");
});
it("server execution rejects a native harness connection before dispatch", async () => {
  const connectionId = connection("server-native");
  const agent = createAgent("server-native", {
    name: "server-native-reject",
    connectionId,
    model: "fixture-model",
  });
  const run = submit("server-native", {
    agentId: agent.id,
    input: "hello",
    idempotencyKey: id(),
  });
  db.prepare("UPDATE connections SET metadata=? WHERE id=?").run(
    JSON.stringify({ loopHarness: "codex" }),
    connectionId,
  );
  await expect(executeAgent(run)).rejects.toThrow("companion deployment");
  expect(
    db.prepare("SELECT 1 FROM native_dispatch WHERE run_id=?").get(run.id),
  ).toBeUndefined();
  transition(run, "cancelled");
});

it("serializes mixed legacy and per-conversation work in either order", async () => {
  const { enqueue } = await import("../src/server/queue");
  for (const nativeFirst of [false, true]) {
    const owner = "mixed-" + nativeFirst;
    const legacy = connection(owner);
    const native = connection(owner);
    db.prepare("UPDATE connections SET metadata=? WHERE id=?").run(
      JSON.stringify({ loopHarness: "codex" }),
      native,
    );
    const agent = createAgent(owner, {
      name: owner,
      connectionId: legacy,
      model: "fixture-model",
    });
    const make = (connectionId: string) => {
      const cid = id();
      db.prepare(
        "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,'mixed',?)",
      ).run(cid, owner, agent.id, now());
      return enqueue(owner, "test", id(), {
        agent: agent.id,
        conversation: cid,
        payload: { connectionId },
      });
    };
    const first = make(nativeFirst ? native : legacy);
    const second = make(nativeFirst ? legacy : native);
    expect(claim("mixed-first")?.id).toBe(first.id);
    expect(claim("mixed-blocked")).toBeUndefined();
    // An active lease still blocks even if its timestamp is later than the candidate.
    db.prepare("UPDATE runs SET created_at=created_at+10000 WHERE id=?").run(
      first.id,
    );
    expect(claim("mixed-active-blocked")).toBeUndefined();
    transition(first, "completed");
    expect(claim("mixed-second")?.id).toBe(second.id);
    transition(second, "completed");
  }
});
