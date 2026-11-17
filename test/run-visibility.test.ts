import { productionApp } from "./helpers/app.js";
import { testDirectory } from "./helpers/test-workspace.js";
import { afterAll, expect, it } from "vitest";

testDirectory();

const { db, id, now } = await import("../src/server/db");
const { seal } = await import("../src/server/secrets");
const { createAgent, Problem } = await import("../src/server/domain");
const { submit } = await import("../src/server/agent-runtime");
const { tick, execute } = await import("../src/server/worker");
const { withTestAdapter } = await import("../src/server/providers");
const { transition } = await import("../src/server/queue");
const { resultsRevision, resultsUpdates } =
  await import("../src/server/results");
const { core } = await import("../src/server/core-routes");
const app = await productionApp("alice", [core], { ownerHeader: "x-owner" });
const base = app.url + "/api";
const connection = id();
db.prepare(
  "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,'alice','openai','Fixture',?,'connected',?,?)",
).run(
  connection,
  seal("fixture", "alice"),
  JSON.stringify([{ id: "fixture" }]),
  now(),
);
const agent = createAgent("alice", {
  name: "visibility-scout",
  connectionId: connection,
  model: "fixture",
});
const record = (id: string) =>
  db.prepare("SELECT * FROM runs WHERE id=?").get(id) as any;
const get = async (path: string, owner = "alice") =>
  (await fetch(base + path, { headers: { "x-owner": owner } })).json();
afterAll(async () => {
  await app.close();
  db.close();
});

it("exposes failures in conversations and removes unfinished answers from feed updates", async () => {
  const run = submit("alice", {
    agentId: agent.id,
    input: "Show current models",
    idempotencyKey: id(),
  });
  let revision = 0;
  const restore = withTestAdapter("openai", {
    async models() {
      return [];
    },
    async *stream() {
      revision = resultsRevision("alice");
      throw new Problem(422, "Tool input schema is unsupported");
    },
  });
  try {
    await tick(execute);
  } finally {
    restore();
  }
  expect(record(run.id)).toMatchObject({
    state: "failed",
    error: "Tool input schema is unsupported",
  });
  const conversation = await get("/conversations/" + run.conversation_id);
  expect(
    conversation.messages.find((m: any) => m.role === "assistant"),
  ).toMatchObject({
    content: "",
    run_state: "failed",
    run_error: "Tool input schema is unsupported",
  });
  const changes = resultsUpdates("alice", { after: revision, through: 0 });
  expect(changes.items).toEqual([]);
  expect(changes.removed).toHaveLength(1);
  expect((await get("/results")).items).toEqual([]);
  expect(
    (await get("/results?view=prompts")).items.find(
      (m: any) => m.run_id === run.id,
    ),
  ).toMatchObject({ run_state: "failed" });
  expect(
    await get("/conversations/" + run.conversation_id, "bob"),
  ).toMatchObject({ error: "Item not found" });
  expect(resultsUpdates("bob", { after: 0, through: 0 }).items).toEqual([]);
  // Recovery, cancellation and completion must update state even without a new text chunk.
  const after = resultsRevision("alice");
  db.prepare("UPDATE runs SET state='cancelled',error=NULL WHERE id=?").run(
    run.id,
  );
  expect(resultsUpdates("alice", { after, through: 0 }).items).toEqual([]);
  expect(resultsUpdates("alice", { after, through: 0 }).removed).toHaveLength(
    1,
  );
});
it("does not mark a provider response with no text or tool call as completed", async () => {
  const run = submit("alice", {
    agentId: agent.id,
    input: "Empty response",
    idempotencyKey: id(),
  });
  const restore = withTestAdapter("openai", {
    async models() {
      return [];
    },
    async *stream() {
      yield { usage: { tokens: 1 } };
    },
  });
  try {
    await tick(execute);
  } finally {
    restore();
  }
  expect(record(run.id)).toMatchObject({
    state: "failed",
    error: expect.stringContaining("without an answer"),
  });
});
it("keeps partial text when a provider fails and keeps cancelled runs cancelled", async () => {
  for (const cancel of [false, true]) {
    const run = submit("alice", {
      agentId: agent.id,
      input: "Partial " + cancel,
      idempotencyKey: id(),
    });
    const restore = withTestAdapter("openai", {
      async models() {
        return [];
      },
      async *stream() {
        yield { text: "Saved partial response" };
        if (cancel) {
          transition(run, "cancelled");
          return;
        }
        throw new Problem(422, "Provider disconnected");
      },
    });
    try {
      await tick(execute);
    } finally {
      restore();
    }
    expect(record(run.id).state).toBe(cancel ? "cancelled" : "failed");
    const conversation = await get("/conversations/" + run.conversation_id);
    expect(conversation.messages.at(-1)).toMatchObject({
      content: "Saved partial response",
      run_state: cancel ? "cancelled" : "failed",
    });
  }
});
