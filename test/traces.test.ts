import { afterAll, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import express from "express";
const dir = mkdtempSync(join(tmpdir(), "loop-traces-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { seal } = await import("../src/server/secrets");
const { createAgent } = await import("../src/server/domain");
const { submit, executeAgent } = await import("../src/server/agent-runtime");
const { claim, transition } = await import("../src/server/queue");
const { withTestAdapter } = await import("../src/server/providers");
const { resultsRevision, resultsUpdates } =
  await import("../src/server/results");
const { recordTrace, agentTraces } = await import("../src/server/traces");
const { recordConversationUpdate } =
  await import("../src/server/conversation-updates");
const { listRuns } = await import("../src/server/run-attention");
const { search } = await import("../src/server/search");
const { saveArtifact } = await import("../src/server/artifacts");
const { core } = await import("../src/server/core-routes");
const app = express();
app.use(express.json(), (req, res, next) => {
  res.locals.owner = req.get("x-owner") || "alice";
  next();
});
app.use(core);
app.use((e: any, _req: any, res: any, _next: any) =>
  res.status(e.status || 500).json({ error: e.message }),
);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});
const base = "http://127.0.0.1:" + (server.address() as any).port;
const get = async (path: string, owner = "alice") =>
  (await fetch(base + path, { headers: { "x-owner": owner } })).json();
function agent(owner = "alice") {
  const connection = id();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,?,'openai','Fixture',?,'connected',?,?)",
  ).run(
    connection,
    owner,
    seal("fixture", owner),
    JSON.stringify([{ id: "fixture" }]),
    now(),
  );
  return createAgent(owner, {
    name: "trace-" + id().slice(0, 8),
    connectionId: connection,
    model: "fixture",
  });
}
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

it("continues beyond seven rounds through pause/resume and publishes only the final answer", async () => {
  const a = agent();
  const submitted = submit("alice", {
    agentId: a.id,
    input: "Long research task",
    idempotencyKey: id(),
  });
  const run = claim("traces-worker")!;
  const after = resultsRevision("alice");
  let paused = false;
  const restore = withTestAdapter("openai", {
    async models() {
      return [];
    },
    async *stream(_secret, input) {
      const round = input.messages.filter((m) => m.role === "tool").length;
      if (round < 12) {
        yield {
          text: `Checking **source ${round + 1}**.\n\nMore evidence is needed.`,
        };
        expect((await get("/results?agent=" + a.id)).items).toEqual([]);
        expect(
          resultsUpdates("alice", { after, through: 0, agent: a.id }).items,
        ).toEqual([]);
        // The public projection flushes within one 250ms batch, not per token.
        await expect
          .poll(
            () =>
              listRuns("alice", [], true).find((r) => r.id === run.id)
                ?.preview_artifact,
            { timeout: 2000, interval: 10 },
          )
          .toMatchObject({
            content: expect.stringContaining(`source ${round + 1}`),
          });
        yield {
          toolCall: {
            id: `source-${round}`,
            name: "loop_diagram",
            arguments: { title: `Source ${round}`, source: "graph TD; A-->B" },
          },
        };
        recordTrace(run, "newer-tool:" + round, {
          kind: "tool",
          title: "Command",
          content: "/bin/bash -lc 'gh pr list'",
        });
        expect(
          listRuns("alice", [], true).find((r) => r.id === run.id)
            ?.preview_artifact,
        ).toMatchObject({
          content: expect.stringContaining(`source ${round + 1}`),
        });
        if (round === 7 && !paused) {
          paused = true;
          transition(run, "pausing");
        }
      } else yield { text: "Final heliotrope answer." };
    },
  });
  try {
    expect(await executeAgent(run)).toBe(false);
    expect(db.prepare("SELECT state FROM runs WHERE id=?").get(run.id)).toEqual(
      { state: "paused" },
    );
    // Other work can fill a whole feed page while this task is paused. The
    // old placeholder must still be published when the long task finishes.
    for (let i = 0; i < 45; i++)
      saveArtifact("alice", {
        title: "Other finished work " + i,
        kind: "markdown",
        content: "Independent answer",
      });
    const loadedFeed = await get("/results");
    expect(loadedFeed.items).toHaveLength(40);
    transition(run, "queued");
    const resumed = claim("resumed-worker")!;
    expect(resumed.id).toBe(submitted.id);
    expect(await executeAgent(resumed)).toBe(true);
    transition(resumed, "completed");
    expect(
      db.prepare("SELECT result FROM runs WHERE id=?").get(run.id),
    ).toEqual({ result: "Final heliotrope answer." });
    expect(
      db
        .prepare("SELECT round FROM agent_checkpoints WHERE run_id=?")
        .get(run.id),
    ).toEqual({ round: 13 });
    const page = await get("/results?agent=" + a.id);
    expect(page.items).toHaveLength(1);
    expect(page.items[0].content).toBe("Final heliotrope answer.");
    const refreshed = resultsUpdates("alice", {
      after: loadedFeed.revision,
      through: loadedFeed.items.at(-1).cursor,
    });
    expect(refreshed.items.map((item) => item.id)).toContain(page.items[0].id);
    expect((await get("/results")).items[0].id).toBe(page.items[0].id);
    expect(
      resultsUpdates("alice", { after, through: 0, agent: a.id }).items,
    ).toHaveLength(1);
    const traces = await get(`/agents/${a.id}/traces`);
    expect(traces.items.filter((t: any) => t.kind === "tool")).toHaveLength(24);
    expect(
      traces.items.filter((t: any) => t.title === "Agent update"),
    ).toHaveLength(0);
    const messages = await get(`/agents/${a.id}/messages`);
    expect(messages.items[0].final).toBe(1);
    expect(messages.items.filter((m: any) => !m.final)).toHaveLength(12);
    expect(messages.items.find((m: any) => m.final).content).toBe(
      "Final heliotrope answer.",
    );
    const conversation = await get(`/conversations/${run.conversation_id}`);
    expect(
      conversation.messages.filter((m: any) => JSON.parse(m.metadata).progress),
    ).toHaveLength(12);
    expect(conversation.messages[0].role).toBe("user");
    const exported = await get(`/agents/${a.id}/traces/export?run=${run.id}`);
    expect(exported.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "Final heliotrope answer.",
    });
    expect(exported.traces.every((t: any) => t.kind === "tool")).toBe(true);
    expect(conversation.messages.at(-1).content).toBe(
      "Final heliotrope answer.",
    );
    expect((await get(`/agents/${a.id}/traces`, "bob")).error).toBe(
      "Item not found",
    );
    expect(
      (await search("alice", "heliotrope", { agent: a.id })).items,
    ).toHaveLength(1);
    expect(
      (await search("alice", "Source", { agent: a.id })).items,
    ).toHaveLength(0);
  } finally {
    restore();
  }
}, 15000);

it("pages public agent messages and links final responses by message identity in completion order", async () => {
  const a = agent();
  const run = submit("alice", {
    agentId: a.id,
    input: "User prompt stays separate",
    idempotencyKey: id(),
  });
  const messageId = id();
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,'alice',?,?,'assistant','Streaming answer','{\"partial\":true}',1000)",
  ).run(messageId, run.conversation_id, run.id);
  for (let i = 0; i < 220; i++)
    recordConversationUpdate(run, "message:" + i, {
      content: "Public update " + i,
    });
  recordTrace(run, "tool", {
    kind: "tool",
    title: "Command",
    content: "Raw command log",
  });
  recordConversationUpdate(run, "empty", {
    content: "  ",
  });
  db.prepare("UPDATE messages SET created_at=2000 WHERE run_id=?").run(run.id);
  recordConversationUpdate(run, "answer", {
    content: "Streaming answer",
  });
  db.prepare(
    "UPDATE messages SET created_at=3000 WHERE run_id=? AND update_key='answer'",
  ).run(run.id);
  const streaming = await get(`/agents/${a.id}/messages`);
  expect(streaming.items[0]).toMatchObject({
    content: "Streaming answer",
    final: 0,
  });
  recordConversationUpdate(run, "answer", {
    content: "Complete final answer",
    metadata: { final: true },
  });
  db.prepare(
    "UPDATE messages SET content='Complete final answer',metadata='{}' WHERE id=?",
  ).run(messageId);
  // An imported answer has no run trace, but is still part of Messages.
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES(?,'alice',?,'assistant','Imported answer',2500)",
  ).run(id(), run.conversation_id);
  const items: any[] = [];
  let next: string | null = null;
  do {
    const page = await get(
      `/agents/${a.id}/messages` +
        (next ? "?before=" + encodeURIComponent(next) : ""),
    );
    expect(page.items.length).toBeLessThanOrEqual(50);
    items.push(...page.items);
    next = page.next;
  } while (next);
  expect(items).toHaveLength(222);
  expect(new Set(items.map((item) => item.id)).size).toBe(222);
  expect(items[0]).toMatchObject({
    id: messageId,
    content: "Complete final answer",
    final: 1,
    created_at: 3000,
  });
  expect(items[1]).toMatchObject({ content: "Imported answer", final: 1 });
  expect(items.filter((item) => !item.final)).toHaveLength(220);
  let history: any[] = [];
  do {
    const page = await get(
      `/conversations/${run.conversation_id}` +
        (next ? "?before=" + encodeURIComponent(next) : ""),
    );
    expect(page.messages.length).toBeLessThanOrEqual(50);
    history = [...page.messages, ...history];
    next = page.next;
  } while (next);
  expect(history).toHaveLength(223);
  expect(new Set(history.map((item) => item.id)).size).toBe(223);
  expect(history[0].content).toBe("User prompt stays separate");
  expect(history.at(-2).content).toBe("Complete final answer");
  expect(history.at(-1).content).toBe("Imported answer");
  expect(
    history.filter((item) => JSON.parse(item.metadata).progress),
  ).toHaveLength(220);
  const anchored = await get(
    `/conversations/${run.conversation_id}?message=${history[100].id}`,
  );
  expect(
    anchored.messages.some((item: any) => item.id === history[100].id),
  ).toBe(true);
  expect(
    (await fetch(`${base}/conversations/${run.conversation_id}?before=invalid`))
      .status,
  ).toBe(400);
  expect(
    items.some((item) => /User prompt|Raw command/.test(item.content)),
  ).toBe(false);
  expect(
    (await fetch(`${base}/agents/${a.id}/messages?before=garbage`)).status,
  ).toBe(400);
  expect(
    (
      await fetch(`${base}/agents/${a.id}/messages`, {
        headers: { "x-owner": "bob" },
      })
    ).status,
  ).toBe(404);
  transition(run, "cancelled");
});

it("keeps cancellation effective after the old round limit", async () => {
  const a = agent(),
    run = submit("alice", {
      agentId: a.id,
      input: "Cancel long work",
      idempotencyKey: id(),
    });
  const claimed = claim("cancel-worker")!;
  const restore = withTestAdapter("openai", {
    async models() {
      return [];
    },
    async *stream(_key, input) {
      const round = input.messages.filter((m) => m.role === "tool").length;
      yield { text: `Update ${round}` };
      if (round === 9) {
        transition(run, "cancelled");
        return;
      }
      yield {
        toolCall: {
          id: "tool-" + round,
          name: "loop_diagram",
          arguments: { title: "Working", source: "graph TD; A-->B" },
        },
      };
    },
  });
  try {
    expect(await executeAgent(claimed)).toBe(false);
    expect((await get("/results?agent=" + a.id)).items).toEqual([]);
  } finally {
    restore();
  }
});

it("paginates durable traces and updates a trace without duplicating it", async () => {
  const a = agent(),
    run = submit("alice", {
      agentId: a.id,
      input: "Trace pages",
      idempotencyKey: id(),
    });
  for (let i = 0; i < 90; i++)
    recordTrace(run, "step:" + i, {
      kind: "tool",
      title: "Update",
      content: String(i),
    });
  const first = agentTraces("alice", a.id);
  expect(first.items).toHaveLength(40);
  const second = agentTraces("alice", a.id, first.next!);
  const third = agentTraces("alice", a.id, second.next!);
  expect(
    new Set([...first.items, ...second.items, ...third.items].map((t) => t.id))
      .size,
  ).toBe(90);
  recordTrace(run, "step:89", {
    kind: "tool",
    title: "Updated",
    content: "Same event",
  });
  expect(agentTraces("alice", a.id).items[0]).toMatchObject({
    id: first.items[0].id,
    title: "Updated",
  });
  transition(run, "cancelled");
});

it("deduplicates legacy answer representations by run without hiding edited files or distinct prompts", async () => {
  const a = agent("legacy"),
    run = submit("legacy", {
      agentId: a.id,
      input: "A question",
      idempotencyKey: id(),
    });
  const message = id();
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,'legacy',?,?,'assistant',?,?)",
  ).run(message, run.conversation_id, run.id, "Quasar result\r\n", now());
  const artifact = saveArtifact("legacy", {
    title: "Quasar answer",
    content: "Quasar result\n",
    agent: a.id,
    conversation: run.conversation_id,
    run: run.id,
  });
  const trace = saveArtifact("legacy", {
    title: "Quasar tool",
    content: "Quasar raw result",
    agent: a.id,
    conversation: run.conversation_id,
    run: run.id,
    metadata: { tool: "web_search" },
  });
  const result = await search("legacy", "Quasar");
  expect(result.items.map((i) => i.id)).toEqual(["artifact:" + artifact]);
  expect(result.items[0].message_id).toBe(message);
  expect(result.items.some((i) => i.id === "artifact:" + trace)).toBe(false);
  db.prepare(
    "UPDATE artifacts SET content='Edited quasar result' WHERE id=?",
  ).run(artifact);
  expect((await search("legacy", "Quasar")).items).toHaveLength(2);
  transition(run, "cancelled");
});

it("migrates old concatenated output into traces and preserves saved edits", () => {
  const legacy = new Database(":memory:");
  try {
    for (const file of readdirSync("migrations")
      .filter((f) => f.endsWith(".sql") && Number(f.split("-")[0]) < 18)
      .sort())
      legacy.exec(readFileSync(join("migrations", file), "utf8"));
    for (const edited of [false, true]) {
      const key = String(edited);
      legacy
        .prepare(
          "INSERT INTO conversations(id,owner_id,title,created_at) VALUES(?,'owner','Legacy',1)",
        )
        .run(key);
      legacy
        .prepare(
          "INSERT INTO runs(id,owner_id,conversation_id,input,state,idempotency_key,result,created_at,updated_at) VALUES(?,'owner',?,'Question','completed',?,'Checking.Final.',1,1)",
        )
        .run(key, key, key);
      legacy
        .prepare(
          "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,'owner',?,?,'assistant','Checking.Final.',1)",
        )
        .run(key, key, key);
      legacy
        .prepare(
          "INSERT INTO artifacts(id,owner_id,conversation_id,run_id,title,kind,content,created_at,updated_at) VALUES(?,'owner',?,?,'Answer','markdown',?,1,1)",
        )
        .run(key, key, key, edited ? "User edit" : "Checking.Final.");
      legacy
        .prepare(
          "INSERT INTO artifact_versions VALUES(?,?,1,'Checking.Final.',1)",
        )
        .run(key, key);
      if (edited)
        legacy
          .prepare("INSERT INTO artifact_versions VALUES(?,?,2,'User edit',2)")
          .run(key + "edit", key);
      legacy
        .prepare(
          "INSERT INTO agent_checkpoints(run_id,message_id,artifact_id,round,history,output,stage) VALUES(?,?,?,2,?,'Checking.Final.','done')",
        )
        .run(
          key,
          key,
          key,
          JSON.stringify([
            { role: "assistant", content: "Earlier conversation answer" },
            { role: "user", content: "Question" },
            {
              role: "assistant",
              content: "Checking.",
              toolCalls: [{ id: "x" }],
            },
            { role: "tool", content: "Evidence" },
            { role: "assistant", content: "Final." },
          ]),
        );
    }
    legacy.exec(readFileSync("migrations/018-agent-traces.sql", "utf8"));
    expect(
      legacy
        .prepare(
          "SELECT title,content FROM run_traces WHERE run_id='false' ORDER BY id",
        )
        .all(),
    ).toEqual([
      { title: "Agent update", content: "Checking." },
      { title: "Final answer", content: "Final." },
    ]);
    expect(
      legacy.prepare("SELECT content FROM artifacts WHERE id='false'").get(),
    ).toEqual({ content: "Final." });
    expect(
      legacy.prepare("SELECT content FROM artifacts WHERE id='true'").get(),
    ).toEqual({ content: "User edit" });
    expect(legacy.prepare("SELECT content FROM messages").all()).toEqual([
      { content: "Final." },
      { content: "Final." },
    ]);
  } finally {
    legacy.close();
  }
});

it("scopes failure details to the requested run and preserves owner/agent isolation", async () => {
  const a = agent(),
    foreign = agent("bob");
  const first = submit("alice", {
    agentId: a.id,
    input: "Failed attempt",
    idempotencyKey: id(),
  });
  const second = submit("alice", {
    agentId: a.id,
    input: "Other attempt",
    idempotencyKey: id(),
  });
  const secret = submit("bob", {
    agentId: foreign.id,
    input: "Private attempt",
    idempotencyKey: id(),
  });
  for (const run of [first, second, secret])
    recordTrace(run, "run:failure", {
      kind: "tool",
      title: "Run failure",
      content: run.input,
      metadata: { state: "failed", isError: true },
    });
  const details = await get(`/agents/${a.id}/traces?run=${first.id}`);
  expect(details.items).toHaveLength(1);
  expect(details.items[0]).toMatchObject({
    run_id: first.id,
    content: "Failed attempt",
  });
  expect((await get(`/agents/${a.id}/traces?run=${secret.id}`)).items).toEqual(
    [],
  );
  expect(
    (await get(`/agents/${foreign.id}/traces?run=${secret.id}`)).error,
  ).toBeDefined();
  for (const run of [first, second, secret]) transition(run, "cancelled");
});

it("filters traces by every term, including linked tool results, within the owner's agent", async () => {
  const a = agent(),
    other = agent(),
    foreign = agent("bob");
  const run = submit("alice", {
    agentId: a.id,
    input: "Search traces",
    idempotencyKey: id(),
  });
  const sibling = submit("alice", {
    agentId: other.id,
    input: "Sibling agent",
    idempotencyKey: id(),
  });
  const secret = submit("bob", {
    agentId: foreign.id,
    input: "Private",
    idempotencyKey: id(),
  });
  recordTrace(run, "tool:npm", {
    kind: "tool",
    title: "Command",
    content: "npm test -- --grep zeppelin İstanbul",
  });
  recordTrace(run, "tool:git", {
    kind: "tool",
    title: "Command",
    content: "git log zeppelin",
  });
  recordTrace(run, "turn:final", {
    kind: "message",
    title: "Final answer",
    content: "Zeppelin summary",
    metadata: { final: true },
  });
  const result = saveArtifact("alice", {
    title: "web_search",
    content: "Marmalade harbour result",
    agent: a.id,
    conversation: run.conversation_id,
    run: run.id,
    metadata: { tool: "web_search" },
  });
  recordTrace(run, "tool:search", {
    kind: "tool",
    title: "web_search",
    artifactId: result,
  });
  for (const r of [sibling, secret])
    recordTrace(r, "tool:npm", {
      kind: "tool",
      title: "Command",
      content: "npm test zeppelin",
    });
  const keys = (q: string, agentId = a.id, owner = "alice") =>
    agentTraces(owner, agentId, undefined, undefined, q).items.map(
      (t: any) => t.trace_key,
    );
  expect(keys("zeppelin")).toEqual(["tool:git", "tool:npm"]);
  expect(keys("npm zep")).toEqual(["tool:npm"]);
  expect(keys("npm -- __ zep")).toEqual(["tool:npm"]);
  expect(keys("-- __")).toEqual([]);
  expect(keys("harbour")).toEqual(["tool:search"]);
  expect(keys("web_sea")).toEqual(["tool:search"]);
  expect(keys("we_sea")).toEqual(["tool:search"]);
  expect(keys("npm-zep")).toEqual(["tool:npm"]);
  expect(keys("İstanbul")).toEqual(["tool:npm"]);
  expect(keys("npm ".repeat(25) + "zep")).toEqual(["tool:npm"]);
  expect(keys("zeppelin", foreign.id, "bob")).toEqual(["tool:npm"]);
  expect(() => keys("zeppelin", a.id, "bob")).toThrow("Item not found");
  expect(keys("!!")).toEqual([]);
  expect(
    agentTraces("alice", a.id, undefined, undefined, "").items,
  ).toHaveLength(3);
  // Workspace search stays conversation-first.
  expect((await search("alice", "harbour")).items).toEqual([]);

  recordTrace(run, "tool:git", {
    kind: "tool",
    title: "Command",
    content: "git status",
  });
  expect(keys("zeppelin")).toEqual(["tool:npm"]);
  expect(keys("status")).toEqual(["tool:git"]);
  expect(
    (await get(`/agents/${a.id}/traces?q=${encodeURIComponent("git status")}`))
      .items,
  ).toMatchObject([{ trace_key: "tool:git" }]);
  for (const r of [run, sibling, secret]) transition(r, "cancelled");
});

it("exports a whole run's public traces, including its final answer", async () => {
  const a = agent(),
    foreign = agent("bob");
  const run = submit("alice", {
    agentId: a.id,
    input: "Export me",
    idempotencyKey: id(),
  });
  const other = submit("alice", {
    agentId: a.id,
    input: "Other run",
    idempotencyKey: id(),
  });
  recordTrace(run, "turn:1", {
    kind: "message",
    title: "Agent update",
    content: "Looking",
  });
  recordTrace(run, "tool:1", {
    kind: "tool",
    title: "Command",
    content: "ls",
    metadata: { state: "completed" },
  });
  recordTrace(run, "empty", { kind: "message", title: "Agent update" });
  recordTrace(run, "turn:2", {
    kind: "message",
    title: "Final answer",
    content: "Done",
    metadata: { final: true },
  });
  recordTrace(other, "tool:1", {
    kind: "tool",
    title: "Command",
    content: "pwd",
  });
  const response = await fetch(
    `${base}/agents/${a.id}/traces/export?run=${run.id}`,
    { headers: { "x-owner": "alice" } },
  );
  expect(response.headers.get("content-disposition")).toContain(
    `loop-run-${run.id}-traces.json`,
  );
  const data = await response.json();
  expect(data).toMatchObject({
    agent: { id: a.id },
    run: { id: run.id, input: "Export me" },
    truncated: false,
  });
  expect(data.traces.map((t: any) => [t.trace_key, t.content])).toEqual([
    ["turn:1", "Looking"],
    ["tool:1", "ls"],
    ["turn:2", "Done"],
  ]);
  expect(data.traces[1].metadata).toEqual({ state: "completed" });
  expect(data.messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ role: "user", content: run.input }),
    ]),
  );
  const denied = [
    [`/agents/${a.id}/traces/export?run=${run.id}`, "bob"],
    [`/agents/${foreign.id}/traces/export?run=${run.id}`, "bob"],
    [`/agents/${a.id}/traces/export?run=missing`, "alice"],
  ] as const;
  for (const [path, owner] of denied) {
    const r = await fetch(base + path, { headers: { "x-owner": owner } });
    expect(r.status).toBe(404);
  }
  for (const r of [run, other]) transition(r, "cancelled");
});

it.each(["traces", "messages"] as const)(
  "exports a bounded truncated %s page without counting the omitted sentinel",
  async (kind) => {
    const a = agent(),
      run = submit("alice", {
        agentId: a.id,
        input: "Bounded truncated export",
        idempotencyKey: id(),
      });
    try {
      const large = JSON.stringify({
        progress: true,
        unexported: "x".repeat(25 * 1024 * 1024),
      });
      // Reuse statements: thousands of individually prepared trigger-heavy
      // writes can retain compiler allocations unrelated to the export bound.
      const trace = db.prepare(
        "INSERT INTO run_traces(owner_id,run_id,trace_key,kind,title,content,metadata,created_at) VALUES('alice',?,?,'tool','Fixture','Public trace',?,1)",
      );
      const message = db.prepare(
        "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,'alice',?,?,'assistant','Public update',?,?)",
      );
      db.transaction(() => {
        if (kind === "traces") {
          for (let i = 0; i <= 5000; i++)
            trace.run(run.id, `bounded-${i}`, i === 5000 ? large : "{}");
        } else {
          // submit already inserted the first user message. Progress metadata
          // keeps these fixture writes from reordering every previous message.
          for (let i = 1; i <= 5000; i++)
            message.run(
              id(),
              run.conversation_id,
              run.id,
              i === 5000 ? large : '{"progress":true}',
              i,
            );
        }
      })();
      const response = await fetch(
        `${base}/agents/${a.id}/traces/export?run=${run.id}`,
        { headers: { "x-owner": "alice" } },
      );
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.truncated).toBe(true);
      expect(data[kind]).toHaveLength(5000);
      expect(data[kind].at(-1).metadata).not.toHaveProperty("unexported");
    } finally {
      transition(run, "cancelled");
    }
  },
  30000,
);

it("refuses exports whose stored or escaped bytes exceed the download bound", async () => {
  const a = agent(),
    run = submit("alice", {
      agentId: a.id,
      input: "Bounded export",
      idempotencyKey: id(),
    });
  try {
    for (const content of [
      "x".repeat(25 * 1024 * 1024),
      "\u0001".repeat(5 * 1024 * 1024),
    ]) {
      recordTrace(run, "bounded", {
        kind: "message",
        title: "Update",
        content,
      });
      const response = await fetch(
        `${base}/agents/${a.id}/traces/export?run=${run.id}`,
        { headers: { "x-owner": "alice" } },
      );
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining("paginated traces"),
      });
    }
  } finally {
    transition(run, "cancelled");
  }
});

it("indexes traces saved before the search migration", () => {
  const legacy = new Database(":memory:");
  legacy.exec(
    "CREATE TABLE schema_version(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL);" +
      "CREATE TABLE run_traces(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,content TEXT NOT NULL DEFAULT '');" +
      "INSERT INTO run_traces(title,content) VALUES('Command','cargo build'),('Command','cargo test');",
  );
  legacy.exec(
    readFileSync(
      join(
        import.meta.dirname,
        "../migrations",
        readdirSync(join(import.meta.dirname, "../migrations")).find((f) =>
          f.endsWith("-trace-search.sql"),
        )!,
      ),
      "utf8",
    ),
  );
  expect(
    legacy
      .prepare("SELECT rowid FROM trace_fts WHERE trace_fts MATCH 'test'")
      .all(),
  ).toEqual([{ rowid: 2 }]);
  legacy.close();
});

it("unwraps updates saved as Loop's reply envelope", () => {
  const legacy = new Database(":memory:");
  try {
    for (const file of readdirSync("migrations")
      .filter((f) => f.endsWith(".sql") && Number(f.split("-")[0]) < 46)
      .sort())
      legacy.exec(readFileSync(join("migrations", file), "utf8"));
    // The traces only need a run id here.
    legacy.pragma("foreign_keys = OFF");
    const insert = legacy.prepare(
      "INSERT INTO run_traces(owner_id,run_id,trace_key,kind,title,content,created_at) VALUES('o','r',?,?,'Agent update',?,1)",
    );
    insert.run(
      "a",
      "message",
      JSON.stringify({
        kind: "answer",
        text: "Verifying each finding.",
        tool: null,
        arguments: "{}",
      }),
    );
    insert.run(
      "b",
      "message",
      JSON.stringify({
        kind: "tool",
        text: "",
        tool: "loop_read_file",
        arguments: "{}",
      }),
    );
    insert.run("c", "message", "Plain update.");
    insert.run("d", "message", '{"other":"json"}');
    insert.run(
      "e",
      "tool",
      JSON.stringify({ kind: "answer", text: "tool output" }),
    );
    legacy.exec(
      readFileSync("migrations/046-unwrap-trace-envelopes.sql", "utf8"),
    );
    expect(
      legacy
        .prepare("SELECT trace_key,content FROM run_traces ORDER BY trace_key")
        .all(),
    ).toEqual([
      { trace_key: "a", content: "Verifying each finding." },
      { trace_key: "b", content: "" },
      { trace_key: "c", content: "Plain update." },
      { trace_key: "d", content: '{"other":"json"}' },
      {
        trace_key: "e",
        content: JSON.stringify({ kind: "answer", text: "tool output" }),
      },
    ]);
    // The trace search index follows the rewritten text.
    expect(
      legacy
        .prepare(
          "SELECT rowid FROM trace_fts WHERE trace_fts MATCH 'verifying'",
        )
        .all(),
    ).toHaveLength(1);
    expect(
      legacy
        .prepare(
          "SELECT rowid FROM trace_fts WHERE trace_fts MATCH 'arguments'",
        )
        .all(),
    ).toHaveLength(0);
  } finally {
    legacy.close();
  }
});

it("keeps native lifecycle events and tool rows out of conversation pages while retaining tool traces", async () => {
  const a = agent();
  const run = submit("alice", {
    agentId: a.id,
    input: "Inspect public output",
    idempotencyKey: id(),
  });
  const bodies = [
    { type: "ready" },
    { type: "loop-turn", status: "completed", output: "Public answer" },
    {
      type: "tool-call",
      name: "exec_command",
      input: "private fixture command",
    },
  ];
  for (let i = 0; i < 65; i++) {
    const n = {
      role: "tool",
      content: JSON.stringify(bodies[i % bodies.length]),
    };
    db.prepare(
      "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,'alice',?,?,?,?,'{}',?)",
    ).run(id(), run.conversation_id, run.id, n.role, n.content, now());
  }
  recordTrace(run, "fixture-tool", {
    kind: "tool",
    title: "exec_command",
    content: "private fixture command",
  });
  recordConversationUpdate(run, "fixture-update", {
    content: "Public progress",
  });
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,'alice',?,?,'assistant','Public answer','{}',?)",
  ).run(id(), run.conversation_id, run.id, now());
  const page = await get(`/conversations/${run.conversation_id}`);
  expect(page.next).toBeNull();
  expect(page.messages.map((m: any) => m.content)).toEqual([
    "Inspect public output",
    "Public progress",
    "Public answer",
  ]);
  expect(
    page.messages.every((m: any) => ["user", "assistant"].includes(m.role)),
  ).toBe(true);
  expect((await get(`/agents/${a.id}/traces`)).items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "tool",
        title: "exec_command",
        content: "private fixture command",
      }),
    ]),
  );
  expect(
    (
      db
        .prepare(
          "SELECT count(*) n FROM messages WHERE conversation_id=? AND role='tool'",
        )
        .get(run.conversation_id) as any
    ).n,
  ).toBe(65);
});

it("keeps system messages and native failure notices in conversation pages", async () => {
  const a = agent();
  const run = submit("alice", {
    agentId: a.id,
    input: "Inspect notices",
    idempotencyKey: id(),
  });
  const system = id();
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,'alice',?,NULL,'system','Imported instructions','{}',?)",
  ).run(system, run.conversation_id, now());
  for (const type of ["error", "loop-delivery-unknown", "ready"])
    db.prepare(
      "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,'alice',?,NULL,'tool',?,?,?)",
    ).run(
      id(),
      run.conversation_id,
      type + " notice",
      JSON.stringify({ native: { type } }),
      now(),
    );
  const page = await get(`/conversations/${run.conversation_id}`);
  expect(page.messages.map((m: any) => m.content)).toEqual(
    expect.arrayContaining([
      "Imported instructions",
      "error notice",
      "loop-delivery-unknown notice",
    ]),
  );
  expect(page.messages.map((m: any) => m.content)).not.toContain(
    "ready notice",
  );
  const anchored = await get(
    `/conversations/${run.conversation_id}?message=${system}`,
  );
  expect(anchored.messages.some((m: any) => m.id === system)).toBe(true);
});

it("opens a conversation anchored on a row the transcript hides", async () => {
  const a = agent();
  const run = submit("alice", {
    agentId: a.id,
    input: "Anchor on hidden activity",
    idempotencyKey: id(),
  });
  const hidden = id();
  db.prepare(
    'INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,\'alice\',?,NULL,\'tool\',\'{"type":"tool-call"}\',\'{"native":{"type":"tool-call"}}\',?)',
  ).run(hidden, run.conversation_id, now());
  const page = await get(
    `/conversations/${run.conversation_id}?message=${hidden}`,
  );
  expect(page.messages.map((m: any) => m.content)).toContain(
    "Anchor on hidden activity",
  );
  expect(page.messages.some((m: any) => m.id === hidden)).toBe(false);
  expect(
    (
      await fetch(
        `${base}/conversations/${run.conversation_id}?message=${id()}`,
      )
    ).status,
  ).toBe(404);
});
