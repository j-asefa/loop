import { afterAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
const dir = mkdtempSync(join(tmpdir(), "loop-review-feedback-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { seal } = await import("../src/server/secrets");
const { createAgent } = await import("../src/server/domain");
const { submit, executeAgent } = await import("../src/server/agent-runtime");
const { withTestAdapter } = await import("../src/server/providers");
const { tick, execute } = await import("../src/server/worker");
const { claim, transition } = await import("../src/server/queue");
const { createTeam } = await import("../src/server/teams");
const { saveArtifact } = await import("../src/server/artifacts");
const { search } = await import("../src/server/search");
const { withTestMcp, discover } = await import("../src/server/mcp/client");
const { installConfig } = await import("../src/server/mcp/install");
const { closeFinishedSessions } = await import("../src/server/mcp/sessions");
const { decide } = await import("../src/server/approvals");
function agent(owner: string) {
  const c = id();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,?,'openai','Fixture',?,'connected',?,?)",
  ).run(
    c,
    owner,
    seal("fixture", owner),
    JSON.stringify([{ id: "fixture" }]),
    now(),
  );
  return createAgent(owner, {
    name: "review-" + id().slice(0, 8),
    connectionId: c,
    model: "fixture",
  });
}
afterAll(async () => {
  await closeFinishedSessions();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

it.each(["query", "stdio", "import"])(
  "redacts %s credentials from tool results, saved versions and model input without reading app resources",
  async (transport) => {
    const owner = id(),
      a = agent(owner);
    let connection: string = id();
    const key = 'fixture-secret-"key+/ &\\ end';
    const values = transport === "query" ? [key] : [key, "s3!"];
    const variants = values.flatMap((value) => [
      value,
      encodeURIComponent(value),
      new URLSearchParams({ key: value }).toString().slice(4),
    ]);
    const echoed = variants.join("\n");
    const secret =
      transport === "query"
        ? { type: "query", query: { api_key: key } }
        : {
            type: "none",
            stdio: {
              command: "node",
              args: [],
              env: { API_KEY: key, SHORT_KEY: "s3!" },
            },
          };
    if (transport !== "import")
      db.prepare(
        "INSERT INTO mcp_connections(id,owner_id,name,url,secret,status,metadata,created_at) VALUES(?,?,'Echo fixture','https://fixture.example/mcp',?,'connected',?,?)",
      ).run(
        connection,
        owner,
        seal(JSON.stringify(secret), owner),
        JSON.stringify({ transport, fixture: true }),
        now(),
      );
    let resourceReads = 0;
    const restoreMcp = withTestMcp(async () => {
      const server = new McpServer({ name: "echo-fixture", version: "1" });
      server.registerTool(
        "diagnostic",
        {
          inputSchema: {},
          _meta: { ui: { resourceUri: "ui://fixture/diagnostic" } },
        },
        async () => ({
          content: [{ type: "text", text: echoed }],
          structuredContent: { diagnostic: echoed, [key]: "value" },
        }),
      );
      server.registerResource(
        "diagnostic",
        "ui://fixture/diagnostic",
        { mimeType: "text/html;profile=mcp-app" },
        async (uri) => {
          resourceReads++;
          return {
            contents: [
              {
                uri: uri.href,
                mimeType: "text/html;profile=mcp-app",
                text: "<pre>" + echoed + "</pre>",
              },
            ],
          };
        },
      );
      const [left, right] = InMemoryTransport.createLinkedPair();
      await server.connect(left);
      const client = new Client({ name: "fixture", version: "1" });
      await client.connect(right);
      return client;
    });
    let modelResult: unknown;
    const restoreProvider = withTestAdapter("openai", {
      async models() {
        return [];
      },
      async *stream(_key, input) {
        const tool = input.messages.find((m) => m.role === "tool");
        if (!tool)
          yield {
            toolCall: {
              id: "diagnostic",
              name: input.tools!.find((t) => t.name.startsWith("loop_tool_"))!
                .name,
              arguments: {},
            },
          };
        else {
          modelResult = JSON.parse(tool.content);
          yield { text: "Diagnostic received." };
        }
      },
    });
    try {
      if (transport === "import") {
        const [installed] = await installConfig(owner, {
          mcpServers: {
            "Echo fixture": {
              url: `https://fixture.example/mcp?api_key=${encodeURIComponent(key)}`,
              headers: { "X-Api-Key": "s3!" },
            },
          },
        });
        expect(installed.status).toBe("connected");
        connection = installed.id;
      } else
        await discover(
          db
            .prepare("SELECT * FROM mcp_connections WHERE id=?")
            .get(connection) as any,
        );
      const run = submit(owner, {
        agentId: a.id,
        input: "Run diagnostic",
        idempotencyKey: id(),
      });
      await tick(execute);
      const approval = db
        .prepare("SELECT id FROM approvals WHERE run_id=?")
        .get(run.id) as any;
      decide(owner, approval.id, "approve");
      await tick(execute);
      expect(
        db.prepare("SELECT state FROM runs WHERE id=?").get(run.id),
      ).toEqual({ state: "completed" });
      const invocation = db
        .prepare(
          "SELECT result,artifact_id FROM tool_invocations WHERE run_id=?",
        )
        .get(run.id) as any;
      const artifact = db
        .prepare("SELECT content,metadata FROM artifacts WHERE id=?")
        .get(invocation.artifact_id) as any;
      const version = db
        .prepare("SELECT content FROM artifact_versions WHERE artifact_id=?")
        .get(invocation.artifact_id) as any;
      const sinks = [
        modelResult,
        JSON.parse(invocation.result),
        artifact.content,
        JSON.parse(artifact.metadata),
        version.content,
      ];
      for (const sink of sinks) {
        const stored = JSON.stringify(sink);
        expect(stored).toContain("[redacted]");
        for (const value of variants)
          expect(stored).not.toContain(JSON.stringify(value).slice(1, -1));
      }
      expect(JSON.parse(artifact.metadata).appResource).toBeUndefined();
      expect(resourceReads).toBe(0);
    } finally {
      restoreProvider();
      restoreMcp();
      await closeFinishedSessions();
    }
  },
);

it("finishes reciprocal teams despite intervening queued tasks without overlapping agent leases", async () => {
  const owner = id(),
    a = agent(owner),
    b = agent(owner);
  const teams = [
    createTeam(owner, {
      name: "A manages B",
      managerId: a.id,
      members: [b.id],
    }),
    createTeam(owner, {
      name: "B manages A",
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
      ) {
        const manager = input.messages.find((m) => m.role === "user")!.content;
        yield {
          toolCall: {
            id: "delegate",
            name: "loop_delegate",
            arguments: {
              tasks: [
                {
                  agentId: manager === "Manager A" ? b.id : a.id,
                  input: "Independent work",
                },
              ],
            },
          },
        };
      } else yield { text: "Finished" };
    },
  });
  try {
    const parents = teams.map((team, i) =>
      submit(owner, {
        agentId: team.manager_id,
        conversationId: team.conversation_id,
        input: "Manager " + (i ? "B" : "A"),
        idempotencyKey: id(),
      }),
    );
    const ordinary = [a, b].map((agent) => {
      const conversation = id();
      db.prepare(
        "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,?,?)",
      ).run(conversation, owner, agent.id, "Queued work", now());
      return submit(owner, {
        agentId: agent.id,
        conversationId: conversation,
        input: "Queued before delegation",
        idempotencyKey: id(),
      });
    });
    for (const parent of parents) {
      const run = claim("manager")!;
      expect(run?.id).toBe(parent.id);
      expect(await executeAgent(run)).toBe(false);
    }
    transition(ordinary[0], "paused");
    const first = claim("child-one");
    expect(claim("paused-agent-stays-blocked")).toBeUndefined();
    transition(ordinary[0], "queued");
    const second = claim("child-two");
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(new Set([first!.agent_id, second!.agent_id])).toEqual(
      new Set([a.id, b.id]),
    );
    expect(claim("blocked")).toBeUndefined();
    expect(await executeAgent(first!)).toBe(true);
    transition(first!, "completed");
    // The first parent may now resume, but its agent still has the other
    // team's child running. Enqueue order must not permit a second lease.
    expect(claim("still-blocked")).toBeUndefined();
    expect(await executeAgent(second!)).toBe(true);
    transition(second!, "completed");
    for (const expected of [...parents, ...ordinary]) {
      const run = claim("finish")!;
      expect(run?.id).toBe(expected.id);
      expect(await executeAgent(run)).toBe(true);
      transition(run, "completed");
    }
    expect(
      db
        .prepare(
          "SELECT count(*) n FROM runs WHERE owner_id=? AND state='completed'",
        )
        .get(owner),
    ).toEqual({ n: 6 });
    expect(claim("empty")).toBeUndefined();
  } finally {
    restore();
    db.prepare(
      "UPDATE runs SET state='cancelled' WHERE owner_id=? AND state<>'completed'",
    ).run(owner);
  }
});

it("preserves separate files and repeated messages while deduplicating only a linked answer", async () => {
  const owner = id(),
    a = agent(owner),
    conversation = id();
  const files = ["Invoice January.pdf", "Invoice February.pdf"].map((title) =>
    saveArtifact(owner, { title, content: "", kind: "file" }),
  );
  expect(
    new Set((await search(owner, "Invoice")).items.map((item) => item.id)),
  ).toEqual(new Set(files.map((file) => "artifact:" + file)));
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,?,?)",
  ).run(conversation, owner, a.id, "Repeated content", now());
  const messages = ["user", "assistant", "assistant"].map((role) => {
    const message = id();
    db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)").run(
      message,
      owner,
      conversation,
      null,
      role,
      "Shared quasar answer",
      "{}",
      now(),
    );
    return message;
  });
  const linked = saveArtifact(owner, {
    title: "Quasar answer",
    content: "Shared quasar answer",
    agent: a.id,
    conversation,
    metadata: { messageId: messages[1] },
  });
  const independent = saveArtifact(owner, {
    title: "Separate quasar note",
    content: "Shared quasar answer",
    agent: a.id,
    conversation,
  });
  const expected = [
    "message:" + messages[0],
    "message:" + messages[2],
    "artifact:" + linked,
    "artifact:" + independent,
  ];
  expect(
    new Set((await search(owner, "quasar")).items.map((item) => item.id)),
  ).toEqual(new Set(expected));
  expect(
    (await search(owner, "quasar")).items.find(
      (item) => item.id === "artifact:" + linked,
    ),
  ).toMatchObject({
    message_id: messages[1],
    url: `/?conversation=${conversation}&message=${messages[1]}`,
  });
  expect(
    (await search(owner, "quasar", { scope: "mine" })).items.map(
      (item) => item.id,
    ),
  ).toEqual(["message:" + messages[0]]);
  db.prepare(
    "UPDATE artifacts SET content='Edited quasar answer' WHERE id=?",
  ).run(linked);
  expect(
    new Set((await search(owner, "quasar")).items.map((item) => item.id)),
  ).toEqual(new Set([...expected, "message:" + messages[1]]));
  expect(
    (await search(owner, "Edited quasar")).items.find(
      (item) => item.id === "artifact:" + linked,
    ),
  ).toMatchObject({ message_id: null, url: `/?artifact=${linked}` });
});
