import { afterAll, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import express from "express";
import { codexTrace, claudeTraces } from "../runtime/traces.mjs";
const dir = mkdtempSync(join(tmpdir(), "loop-traces-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { seal } = await import("../src/server/secrets");
const { createAgent } = await import("../src/server/domain");
const { submit, executeAgent } = await import("../src/server/agent-runtime");
const { claim, transition } = await import("../src/server/queue");
const { withTestAdapter } = await import("../src/server/providers");
const { feedRevision, feedUpdates } = await import("../src/server/feed");
const { recordTrace, agentTraces } = await import("../src/server/traces");
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
  const after = feedRevision("alice");
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
        expect((await get("/feed?agent=" + a.id)).items).toEqual([]);
        expect(
          feedUpdates("alice", { after, through: 0, agent: a.id }).items,
        ).toEqual([]);
        expect(
          listRuns("alice", [], true).find((r) => r.id === run.id)
            ?.preview_artifact,
        ).toMatchObject({
          content: expect.stringContaining(`source ${round + 1}`),
        });
        yield {
          toolCall: {
            id: `source-${round}`,
            name: "loop_diagram",
            arguments: { title: `Source ${round}`, source: "graph TD; A-->B" },
          },
        };
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
    const loadedFeed = await get("/feed");
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
    const page = await get("/feed?agent=" + a.id);
    expect(page.items).toHaveLength(1);
    expect(page.items[0].content).toBe("Final heliotrope answer.");
    const refreshed = feedUpdates("alice", {
      after: loadedFeed.revision,
      through: loadedFeed.items.at(-1).cursor,
    });
    expect(refreshed.items.map((item) => item.id)).toContain(page.items[0].id);
    expect((await get("/feed")).items[0].id).toBe(page.items[0].id);
    expect(
      feedUpdates("alice", { after, through: 0, agent: a.id }).items,
    ).toHaveLength(1);
    const traces = await get(`/agents/${a.id}/traces`);
    expect(traces.items.filter((t: any) => t.kind === "tool")).toHaveLength(12);
    expect(traces.items.some((t: any) => t.title === "Agent update")).toBe(false);
    const messages = await get(`/agents/${a.id}/messages`);
    expect(messages.items.filter((m: any) => !m.final)).toHaveLength(12);
    expect(messages.items.find((m: any) => m.final).content).toBe(
      "Final heliotrope answer.",
    );
    const conversation = await get(`/conversations/${run.conversation_id}`);
    expect(conversation.messages.filter((m: any) => m.id.startsWith("trace:")))
      .toHaveLength(12);
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
    expect((await get("/feed?agent=" + a.id)).items).toEqual([]);
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

it("hides already-saved Claude formatting receipts from traces and Running previews without deleting history", async () => {
  const a = agent();
  const run = submit("alice", {
    agentId: a.id,
    input: "Legacy formatting receipt",
    idempotencyKey: id(),
  });
  const claimed = claim("legacy-format-worker")!;
  expect(claimed.id).toBe(run.id);
  const restore = withTestAdapter("openai", {
    async models() {
      return [];
    },
    async *stream() {
      yield {
        trace: {
          id: "public",
          kind: "message",
          title: "Agent update",
          content: "Checking the existing review",
        },
      };
      yield {
        trace: {
          id: "format",
          kind: "tool",
          title: "StructuredOutput",
          content: '{"kind":"tool"}',
          state: "running",
        },
      };
      yield {
        trace: {
          id: "format:result",
          kind: "tool",
          title: "Tool result",
          content: "Structured output provided successfully",
          state: "completed",
        },
      };
      throw new Error("Fixture rejection");
    },
  });
  try {
    await expect(executeAgent(claimed)).rejects.toThrow();
    transition(run, "failed");
    expect(
      agentTraces("alice", a.id).items.filter(
        (item: any) => item.kind === "tool",
      ),
    ).toEqual([]);
    expect(
      listRuns("alice", [], true).find((r) => r.id === run.id)
        ?.preview_artifact,
    ).toMatchObject({ content: "Checking the existing review" });
    expect(
      db
        .prepare(
          "SELECT count(*) n FROM run_traces WHERE run_id=? AND title='StructuredOutput'",
        )
        .get(run.id),
    ).toEqual({ n: 1 });
  } finally {
    restore();
  }
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

it("captures native public tool activity while excluding reasoning and thinking blocks", () => {
  expect(
    codexTrace({
      method: "item/completed",
      params: {
        item: {
          id: "c",
          type: "commandExecution",
          command: "git status",
          status: "completed",
        },
      },
    }),
  ).toMatchObject({ kind: "tool", content: "git status" });
  expect(
    codexTrace({
      method: "item/completed",
      params: { item: { id: "r", type: "reasoning", text: "private" } },
    }),
  ).toBeUndefined();
  const traces = claudeTraces({
    type: "assistant",
    message: {
      id: "a",
      content: [
        { type: "thinking", thinking: "private" },
        { type: "text", text: "Checking the files" },
        {
          type: "tool_use",
          id: "t",
          name: "Bash",
          input: { command: "git status" },
        },
      ],
    },
  });
  expect(traces).toHaveLength(2);
  expect(JSON.stringify(traces)).not.toContain("private");
});

it("excludes Claude's formatting tool and receipt while retaining native tool errors", () => {
  const internal = new Set<string>();
  expect(
    claudeTraces(
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "format",
              name: "StructuredOutput",
              input: { kind: "tool" },
            },
          ],
        },
      },
      internal,
    ),
  ).toEqual([]);
  const traces = claudeTraces(
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "format",
            content: "Structured output provided successfully",
          },
          {
            type: "tool_result",
            tool_use_id: "real-tool",
            is_error: true,
            content: "Review rejected",
          },
        ],
      },
    },
    internal,
  );
  expect(traces).toEqual([
    {
      id: "real-tool:result",
      kind: "tool",
      title: "Tool result",
      content: "Review rejected",
      state: "failed",
    },
  ]);
});
