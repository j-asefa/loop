import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ownInstructions } from "./helpers/instructions";
const dir = mkdtempSync(join(tmpdir(), "loop-feedback-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
process.env.LOOP_RUNTIME_URL = "http://127.0.0.1:31999";
process.env.LOOP_RUNTIME_TOKEN =
  "fixture-runtime-token-with-at-least-32-characters";
vi.mock("../src/server/local-embeddings.js", () => ({
  localModel: "local:all-MiniLM-L6-v2:q8",
  localEmbeddings: vi.fn(async (texts: string[]) =>
    texts.map((text) => (/car|automobile/.test(text) ? [1, 0] : [0, 1])),
  ),
}));
const { db, id, now } = await import("../src/server/db");
const { seal } = await import("../src/server/secrets");
const { createAgent, owned, Problem } = await import("../src/server/domain");
const { core } = await import("../src/server/core-routes");
const { workspace } = await import("../src/server/workspace-routes");
const { teams, createTeam } = await import("../src/server/teams");
const { mcp } = await import("../src/server/mcp/routes");
const { search, indexPending } = await import("../src/server/search");
const { submit, executeAgent } = await import("../src/server/agent-runtime");
const { nativeBindings, invokeNative } =
  await import("../src/server/native-tools");
const { withTestAdapter } = await import("../src/server/providers");
const { claim, transition } = await import("../src/server/queue");
const { saveArtifact } = await import("../src/server/artifacts");
const { parseMcpConfig } = await import("../src/server/mcp/install");
const { withTestMcp } = await import("../src/server/mcp/client");
const { decide } = await import("../src/server/approvals");
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.locals.owner = req.get("x-test-owner") || "feedback";
  next();
});
app.use(core, workspace, teams, mcp);
app.use((error: Error, _req: any, res: any, _next: any) =>
  res
    .status(error instanceof Problem ? error.status : 400)
    .json({ error: error.message }),
);
let server: ReturnType<typeof app.listen>, origin: string;
beforeAll(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r, reject) => {
    server.once("listening", r);
    server.once("error", reject);
  });
  origin = "http://127.0.0.1:" + (server.address() as any).port;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
async function api(
  path: string,
  body?: unknown,
  method?: string,
  owner = "feedback",
) {
  const r = await fetch(origin + path, {
    method: method || (body ? "POST" : "GET"),
    headers: { "content-type": "application/json", "x-test-owner": owner },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json() };
}
function agent(name: string, owner = "feedback") {
  const connection = id();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,?,'openai','Fixture',?,'connected',?,?)",
  ).run(
    connection,
    owner,
    seal("fixture-key", owner),
    JSON.stringify([{ id: "fixture" }]),
    now(),
  );
  return createAgent(owner, {
    name,
    connectionId: connection,
    model: "fixture",
    instructions: name,
  });
}
it("archives only the feed, preserves history/search, and returns one hit for a response and its artifact", async () => {
  const a = agent("feedback-scout"),
    c = id(),
    m = id();
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,?,?)",
  ).run(c, "feedback", a.id, "Conversation", now());
  db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)").run(
    m,
    "feedback",
    c,
    null,
    "assistant",
    "Unique quasar answer",
    "{}",
    now(),
  );
  const artifact = saveArtifact("feedback", {
    title: "Unique quasar answer",
    content: "Unique quasar answer",
    agent: a.id,
    conversation: c,
    metadata: { messageId: m },
  });
  expect((await search("feedback", "quasar")).items).toHaveLength(1);
  const beforeArchive = (await api("/feed")).data.revision;
  expect(
    (await api("/feed/" + artifact, { hidden: true }, "PATCH", "stranger"))
      .status,
  ).toBe(404);
  expect(
    (await api("/feed/" + artifact, { hidden: true }, "PATCH")).status,
  ).toBe(200);
  expect(
    (await api("/feed")).data.items.some((i: any) => i.id === artifact),
  ).toBe(false);
  expect((await api("/conversations/" + c)).data.messages).toHaveLength(1);
  expect((await api("/artifacts/" + artifact)).data.archived).toBe(0);
  expect((await search("feedback", "quasar")).items).toHaveLength(1);
  const changes = (
    await api("/feed/updates?after=" + beforeArchive + "&through=0")
  ).data;
  expect(changes.removed).toContain(artifact);
  expect(changes.items.some((i: any) => i.id === artifact)).toBe(false);
  await api("/feed/" + artifact, { hidden: false }, "PATCH");
  expect(
    (
      await api("/feed/updates?after=" + changes.revision + "&through=0")
    ).data.items.some((i: any) => i.id === artifact),
  ).toBe(true);
  expect(
    (await api("/feed")).data.items.some((i: any) => i.id === artifact),
  ).toBe(true);
});
it("loads an older deep-linked message and paginates before its window", async () => {
  const c = id(),
    messages: string[] = [];
  db.prepare(
    "INSERT INTO conversations(id,owner_id,title,created_at) VALUES(?,?,?,?)",
  ).run(c, "feedback", "Long history", now());
  db.transaction(() => {
    for (let i = 0; i < 160; i++) {
      const m = id();
      messages.push(m);
      db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)").run(
        m,
        "feedback",
        c,
        null,
        "assistant",
        "Message " + i,
        "{}",
        now(),
      );
    }
  })();
  const result = (await api("/conversations/" + c + "?message=" + messages[72]))
    .data;
  expect(result.messages.some((m: any) => m.id === messages[72])).toBe(true);
  const older = (await api("/conversations/" + c + "?before=" + result.next))
    .data;
  expect(
    new Set([...older.messages, ...result.messages].map((m: any) => m.id)).size,
  ).toBe(older.messages.length + result.messages.length);
  expect(
    (
      await api(
        "/conversations/" + c + "?message=" + messages[72],
        undefined,
        undefined,
        "stranger",
      )
    ).status,
  ).toBe(404);
});
it("finds paraphrases with local embeddings and removes vectors when disabled", async () => {
  saveArtifact("semantic", {
    title: "Travel",
    content: "An automobile is parked outside.",
  });
  saveArtifact("semantic", {
    title: "Cooking",
    content: "Roast vegetables for dinner.",
  });
  db.prepare(
    "UPDATE search_documents SET updated_at=? WHERE owner_id='semantic'",
  ).run(now() - 10000);
  expect(
    (
      await api(
        "/preferences",
        { embeddingEnabled: true, connectionId: null },
        "POST",
        "semantic",
      )
    ).status,
  ).toBe(200);
  await indexPending();
  const result = await search("semantic", "car");
  expect(result.mode).toBe("hybrid");
  expect(result.items).toHaveLength(1);
  expect(result.items[0].title).toBe("Travel");
  expect((await search("stranger", "car")).items).toHaveLength(0);
  await api(
    "/preferences",
    { embeddingEnabled: false, connectionId: null },
    "POST",
    "semantic",
  );
  expect(
    db
      .prepare("SELECT count(*) n FROM embeddings WHERE owner_id='semantic'")
      .get(),
  ).toEqual({ n: 0 });
});
it("runs worker tasks, resumes the manager with results, and filters team feeds without duplicates", async () => {
  const manager = agent("team-manager"),
    first = agent("team-researcher"),
    second = agent("team-reviewer");
  const team = createTeam("feedback", {
    name: "Research",
    managerId: manager.id,
    members: [first.id, second.id],
  });
  expect(() =>
    createTeam("stranger", {
      name: "Leak",
      managerId: manager.id,
      members: [first.id],
    }),
  ).toThrow();
  const restore = withTestAdapter("openai", {
    async models() {
      return [];
    },
    async *stream(_key, input) {
      if (
        ownInstructions(input.instructions) === "team-manager" &&
        !input.messages.some((m) => m.role === "tool")
      )
        yield {
          toolCall: {
            id: "delegate_test_%",
            name: "loop_delegate",
            arguments: {
              tasks: [
                { agentId: first.id, input: "Research the question" },
                { agentId: second.id, input: "Review the evidence" },
              ],
            },
          },
        };
      else
        yield {
          text:
            ownInstructions(input.instructions) === "team-manager"
              ? "Synthesis: both worker results received."
              : "Worker evidence.",
        };
    },
  });
  try {
    const submitted = submit("feedback", {
      agentId: manager.id,
      conversationId: team.conversation_id,
      input: "Investigate",
      idempotencyKey: "team-fixture-key",
    });
    const parent = claim("manager-worker")!;
    expect(parent.id).toBe(submitted.id);
    expect(await executeAgent(parent)).toBe(false);
    expect(
      (
        db
          .prepare("SELECT active_since FROM runs WHERE id=?")
          .get(parent.id) as any
      ).active_since,
    ).toBeNull();
    expect(
      (
        db
          .prepare("SELECT worker_id FROM runs WHERE id=?")
          .get(parent.id) as any
      ).worker_id,
    ).toBeNull();
    const a = claim("worker-a")!,
      b = claim("worker-b")!;
    expect(new Set([a.agent_id, b.agent_id])).toEqual(
      new Set([first.id, second.id]),
    );
    expect(claim("cannot-resume")).toBeUndefined();
    for (const child of [a, b]) {
      expect(await executeAgent(child)).toBe(true);
      transition(child, "completed");
    }
    const resumed = claim("manager-resume")!;
    expect(resumed.id).toBe(parent.id);
    expect(await executeAgent(resumed)).toBe(true);
    transition(resumed, "completed");
    expect(
      db
        .prepare("SELECT count(*) n FROM delegations WHERE parent_run_id=?")
        .get(parent.id),
    ).toEqual({ n: 2 });
    const feed = (await api("/feed?teams=" + team.id)).data.items;
    expect(feed).toHaveLength(3);
    const updates = (
      await api("/feed/updates?after=0&through=0&teams=" + team.id)
    ).data.items;
    expect(new Set(updates.map((item: any) => item.id))).toEqual(
      new Set(feed.map((item: any) => item.id)),
    );
    expect(updates.every((item: any) => item.team_id === team.id)).toBe(true);
    expect(
      (
        await api(
          "/feed/updates?after=0&through=0&teams=" + team.id,
          undefined,
          undefined,
          "stranger",
        )
      ).status,
    ).toBe(404);
    expect(
      (await api("/feed?teams=" + team.id + "," + team.id)).data.items,
    ).toHaveLength(3);
    expect(
      (await api("/feed?teams=" + team.id, undefined, undefined, "stranger"))
        .status,
    ).toBe(404);
    const calls = db
      .prepare("SELECT result FROM native_calls WHERE run_id=?")
      .get(parent.id) as any;
    expect(calls.result).toContain("Worker evidence");
  } finally {
    restore();
  }
});
it("avoids cross-team manager deadlocks and cancels only the selected team's children", async () => {
  const a = agent("reciprocal-a"),
    b = agent("reciprocal-b");
  const teams = [
    createTeam("feedback", {
      name: "First reciprocal",
      managerId: a.id,
      members: [b.id],
    }),
    createTeam("feedback", {
      name: "Second reciprocal",
      managerId: b.id,
      members: [a.id],
    }),
  ];
  const restore = withTestAdapter("openai", {
    async models() {
      return [];
    },
    async *stream(_key, input) {
      if (
        input.tools?.some((t) => t.name === "loop_delegate") &&
        !input.messages.some((m) => m.role === "tool")
      )
        yield {
          toolCall: {
            id: "reciprocal-delegate",
            name: "loop_delegate",
            arguments: {
              tasks: [
                {
                  agentId:
                    ownInstructions(input.instructions) === a.instructions
                      ? b.id
                      : a.id,
                  input: "Independent evidence",
                },
              ],
            },
          },
        };
      else yield { text: "Independent result" };
    },
  });
  try {
    for (const team of teams)
      submit("feedback", {
        agentId: team.manager_id,
        conversationId: team.conversation_id,
        input: "Coordinate",
        idempotencyKey: "reciprocal-" + team.id,
      });
    const parents: NonNullable<ReturnType<typeof claim>>[] = [];
    for (let i = 0; i < 2; i++) {
      const parent = claim("manager-" + i)!;
      parents.push(parent);
      expect(await executeAgent(parent)).toBe(false);
    }
    const children = [
      claim("reciprocal-worker-a")!,
      claim("reciprocal-worker-b")!,
    ];
    expect(children.every(Boolean)).toBe(true);
    expect(new Set(children.map((c) => c.agent_id))).toEqual(
      new Set([a.id, b.id]),
    );
    expect((await api("/runs/" + parents[0].id + "/cancel", {})).status).toBe(
      200,
    );
    const childFor = (parent: string) =>
      (
        db
          .prepare("SELECT child_run_id FROM delegations WHERE parent_run_id=?")
          .get(parent) as any
      ).child_run_id;
    expect(
      (
        db
          .prepare("SELECT state FROM runs WHERE id=?")
          .get(childFor(parents[0].id)) as any
      ).state,
    ).toBe("cancelled");
    const remaining = children.find((c) => c.id === childFor(parents[1].id))!;
    expect(await executeAgent(remaining)).toBe(true);
    transition(remaining, "completed");
    const resumed = claim("reciprocal-resume")!;
    expect(resumed.id).toBe(parents[1].id);
    expect(await executeAgent(resumed)).toBe(true);
    transition(resumed, "completed");
  } finally {
    restore();
  }
});
it("accepts the reported Playwright JSON, rejects invalid blocks, and requires approval for agent installation", async () => {
  const config = {
    mcpServers: {
      playwright: { command: "npx", args: ["@playwright/mcp@latest"] },
    },
  };
  expect(parseMcpConfig(config)[0][0]).toBe("playwright");
  expect(() =>
    parseMcpConfig({ mcpServers: { bad: { command: "npx; echo bad" } } }),
  ).toThrow();
  expect(() =>
    parseMcpConfig({ mcpServers: { bad: { url: "http://127.0.0.1/mcp" } } }),
  ).toThrow();
  expect(() =>
    parseMcpConfig({
      mcpServers: {
        bad: { url: "https://example.com/mcp", headers: { Host: "secret" } },
      },
    }),
  ).toThrow();
  const existing = agent("tool-consumer");
  const a = agent("tool-installer");
  const run = submit("feedback", {
    agentId: a.id,
    input: "Install Playwright",
    idempotencyKey: "install-fixture-key",
  });
  const claimed = claim("installer")!;
  expect(claimed.id).toBe(run.id);
  const binding = nativeBindings(claimed).find(
    (b) => b.tool === "loop_install_mcp",
  )!;
  const input = { config: JSON.stringify(config) };
  const pending = await invokeNative(claimed, binding, "installation", input);
  expect("pending" in pending).toBe(true);
  expect(db.prepare("SELECT count(*) n FROM mcp_connections").get()).toEqual({
    n: 0,
  });
  const restore = withTestMcp(async () => {
    const server = new McpServer({ name: "MCP fixture", version: "1" });
    server.registerTool("inspect_page", { inputSchema: {} }, async () => ({
      content: [{ type: "text", text: "Fixture" }],
    }));
    const [left, right] = InMemoryTransport.createLinkedPair();
    await server.connect(left);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(right);
    return client;
  });
  try {
    decide("feedback", (pending as { pending: string }).pending, "approve");
    const resumed = claim("installer-resume")!;
    const result = await invokeNative(resumed, binding, "installation", input);
    expect("result" in result).toBe(true);
    const installed = (await api("/mcp")).data[0];
    const expected = [{ connection_id: installed.id, tool: "inspect_page" }];
    expect((await api("/agents/" + a.id + "/tools")).data).toEqual(expected);
    expect((await api("/agents/" + existing.id + "/tools")).data).toEqual(
      expected,
    );
    const future = await api("/agents", {
      name: "future-tool-consumer",
      connectionId: existing.connection_id,
      model: "fixture",
    });
    expect(future.status).toBe(201);
    expect((await api("/agents/" + future.data.id + "/tools")).data).toEqual(
      expected,
    );
    const other = agent("other-tools", "other-owner");
    expect(
      (
        await api(
          "/agents/" + other.id + "/tools",
          undefined,
          undefined,
          "other-owner",
        )
      ).data,
    ).toEqual([]);
    expect((await api("/agents/" + a.id + "/tools", [], "PUT")).status).toBe(
      410,
    );
    expect(
      (await api("/agents/" + a.id + "/tools", [], "PUT", "other-owner"))
        .status,
    ).toBe(404);
    expect(db.prepare("SELECT count(*) n FROM grants").get()).toEqual({ n: 0 });
    await invokeNative(resumed, binding, "installation", input);
    expect(db.prepare("SELECT count(*) n FROM mcp_connections").get()).toEqual({
      n: 1,
    });
    const connection = (await api("/mcp")).data[0];
    expect(connection.secret).toBeUndefined();
    transition(resumed, "completed");
  } finally {
    restore();
  }
});
it("creates native diagrams without a provider or external MCP call", async () => {
  const a = agent("diagram-author"),
    submitted = submit("feedback", {
      agentId: a.id,
      input: "Draw it",
      idempotencyKey: "diagram-fixture-key",
    });
  const run = claim("diagram")!;
  expect(run.id).toBe(submitted.id);
  const binding = nativeBindings(run).find((b) => b.tool === "loop_diagram")!;
  const result = await invokeNative(run, binding, "diagram", {
    title: "Flow",
    source: "flowchart TD\nA[Start] --> B[Finish]",
  });
  expect("result" in result).toBe(true);
  if ("result" in result)
    expect(owned<any>("artifacts", result.artifactId, "feedback").kind).toBe(
      "diagram",
    );
  await expect(
    invokeNative(run, binding, "unsafe", {
      title: "Unsafe",
      source: "flowchart TD\nclick A callback",
    }),
  ).rejects.toThrow();
  transition(run, "completed");
});
