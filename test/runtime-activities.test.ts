import { afterAll, afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  claudeActivities,
  claudeTraces,
  codexActivity,
  codexTrace,
} from "../runtime/traces.mjs";

// Subscription runs execute in a Codex or Claude Code runtime whose own
// executor reports structured command/file results. These tests drive the
// real runtime serializers (runtime/traces.mjs, as used by runtime/entry.mjs)
// through the runtime NDJSON transport into executeAgent and the shared
// activity store. No model or network call is made.
const dir = mkdtempSync(join(tmpdir(), "loop-runtime-activities-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
process.env.LOOP_RUNTIME_URL = "http://runtime.fixture";
process.env.LOOP_RUNTIME_TOKEN =
  "activities-fixture-token-with-at-least-32-characters";
const { db, id, now } = await import("../src/server/db");
const { seal } = await import("../src/server/secrets");
const { createAgent } = await import("../src/server/domain");
const { submit, executeAgent } = await import("../src/server/agent-runtime");
const { claim, transition } = await import("../src/server/queue");
const { withTestAdapter } = await import("../src/server/providers");
const { listActivities } = await import("../src/server/activities");

afterEach(() => {
  vi.unstubAllGlobals();
});
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// Claude Code subscriptions are stored as provider "anthropic".
function subscriptionAgent(provider: "codex" | "anthropic") {
  const connection = id();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,'alice',?,'Fixture','','connected',?,?,?)",
  ).run(
    connection,
    provider,
    JSON.stringify([{ id: "fixture" }]),
    JSON.stringify({ authMode: "subscription" }),
    now(),
  );
  return createAgent("alice", {
    name: provider + "-" + id().slice(0, 8),
    connectionId: connection,
    model: "fixture",
  });
}

// Serve one runtime turn as runtime/entry.mjs would: every chunk it emits.
function serveRuntime(chunks: object[]) {
  vi.stubGlobal("fetch", async (url: string) => {
    expect(url).toBe("http://runtime.fixture/runtime");
    const body =
      [...chunks.map((chunk) => ({ chunk })), { chunk: { text: "Done." } }, { done: true }]
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n";
    return new Response(body);
  });
}

async function runTurn(agentId: string, conversationId?: string) {
  const submitted = submit("alice", {
    agentId,
    input: "Fix the failing test",
    idempotencyKey: id(),
    ...(conversationId && { conversationId }),
  });
  const run = claim("activities-worker")!;
  expect(run.id).toBe(submitted.id);
  expect(await executeAgent(run)).toBe(true);
  transition(run, "completed");
  return run;
}

const byKind = (conversation: string, kind: string) =>
  listActivities("alice", conversation).items.filter((i: any) => i.kind === kind);

// Codex app-server notifications for one turn (shapes from codex app-server
// v2 item/started, item/completed and turn/plan/updated).
const codexTurn = (turnId: string) => [
  {
    method: "turn/plan/updated",
    params: {
      threadId: "t",
      turnId,
      explanation: "Reproduce, then fix",
      plan: [
        { step: "Run the tests", status: "completed" },
        { step: "Fix the parser", status: "inProgress" },
      ],
    },
  },
  {
    method: "item/started",
    params: {
      threadId: "t",
      turnId,
      item: { id: "cmd-1", type: "commandExecution", command: "npm test", cwd: "/work", status: "inProgress" },
    },
  },
  {
    method: "item/completed",
    params: {
      threadId: "t",
      turnId,
      item: {
        id: "cmd-1",
        type: "commandExecution",
        command: "npm test",
        cwd: "/work",
        status: "completed",
        exitCode: 1,
        aggregatedOutput: "FAIL parser.test.ts\n",
      },
    },
  },
  {
    method: "item/completed",
    params: {
      threadId: "t",
      turnId,
      item: {
        id: "edit-1",
        type: "fileChange",
        status: "completed",
        changes: [
          { path: "src/parser.ts", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-a\n+b\n" },
          { path: "src/new.ts", kind: { type: "add" }, diff: "+export {};\n" },
          { path: "src/old.ts", kind: { type: "update", move_path: "src/renamed.ts" }, diff: "" },
        ],
      },
    },
  },
];
const codexChunks = (turnId: string) =>
  codexTurn(turnId).flatMap((message) => {
    const trace = codexTrace(message);
    const activity = codexActivity(message);
    return [...(trace ? [{ trace }] : []), ...(activity ? [{ activity }] : [])];
  });

it("maps Codex runtime command, file and plan results into shared activities", async () => {
  const agent = subscriptionAgent("codex");
  serveRuntime(codexChunks("turn-1"));
  const run = await runTurn(agent.id);
  const conversation = run.conversation_id!;

  const [output] = byKind(conversation, "output");
  expect(output.run).toBe(run.id);
  expect(output.record.source).toEqual({ transport: "api", harness: "codex", origin: "codex:runtime" });
  expect(output.record.data).toMatchObject({
    command: "npm test",
    cwd: "/work",
    status: "exited",
    exitCode: 1,
  });
  expect(output.record.data.chunks.map((c: any) => c.text).join("")).toBe("FAIL parser.test.ts\n");

  const files = byKind(conversation, "file_change").map((i: any) => i.record.data);
  expect(files.map((f: any) => [f.state, f.files[0].operation, f.files[0].path])).toEqual([
    ["applied", "modify", "src/parser.ts"],
    ["applied", "create", "src/new.ts"],
    ["applied", "rename", "src/renamed.ts"],
  ]);
  expect(files[2].files[0].oldPath).toBe("src/old.ts");
  expect(files[0].files[0].patch).toContain("+b");

  const plans = byKind(conversation, "plan").map((i: any) => i.record);
  expect(plans).toHaveLength(1);
  expect(plans[0].data).toMatchObject({ explanation: "Reproduce, then fix", revision: 1 });
  expect(plans[0].data.steps.map((s: any) => s.status)).toEqual(["completed", "in_progress"]);

  // The runtime's text traces stay as tool cards; activities are additional
  // typed panels, not a second tool card for the same invocation.
  expect(byKind(conversation, "tool").every((t: any) => t.legacy)).toBe(true);

  const [caps] = byKind(conversation, "capabilities");
  expect(caps.record.source).toEqual({ transport: "api", harness: "codex" });
  expect(caps.record.capabilities).toMatchObject({
    output: { state: "supported" },
    diffs: { state: "supported" },
    commands: { state: "supported" },
    plans: { state: "supported" },
  });

  // A later turn with an older runtime (text traces only) keeps what this
  // conversation's runtime already demonstrated instead of flapping.
  serveRuntime(codexTurn("turn-2").flatMap((m) => {
    const trace = codexTrace(m);
    return trace ? [{ trace }] : [];
  }));
  const second = await runTurn(agent.id, conversation);
  expect(second.conversation_id).toBe(conversation);
  expect(byKind(conversation, "output")).toHaveLength(1);
  const [again] = byKind(conversation, "capabilities");
  expect(again.record.capabilities.output.state).toBe("supported");
});

it("reports structured features as undiscovered until the runtime sends them", async () => {
  const agent = subscriptionAgent("codex");
  serveRuntime([{ trace: { id: "x", kind: "tool", title: "Run command", content: "ls" } }]);
  const run = await runTurn(agent.id);
  const [caps] = byKind(run.conversation_id!, "capabilities");
  expect(caps.record.capabilities.output).toMatchObject({
    state: "undiscovered",
    reason: expect.stringContaining("first structured command result"),
  });
  expect(caps.record.capabilities.diffs.state).toBe("undiscovered");
  expect(byKind(run.conversation_id!, "output")).toEqual([]);
});

it("maps correlated Claude Code Bash, Write and TodoWrite blocks only", async () => {
  const agent = subscriptionAgent("anthropic");
  const pending = new Set<string>();
  const internal = new Set<string>();
  const messages = [
    {
      type: "assistant",
      message: {
        id: "m1",
        content: [
          { type: "tool_use", id: "todo-1", name: "TodoWrite", input: { todos: [{ content: "Write notes", status: "in_progress" }] } },
          { type: "tool_use", id: "bash-1", name: "Bash", input: { command: "ls -la" } },
          { type: "tool_use", id: "write-1", name: "Write", input: { file_path: "notes.md", content: "# Notes\n" } },
          { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "secret.txt" } },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "bash-1", content: [{ type: "text", text: "total 0\n" }] },
          { type: "tool_result", tool_use_id: "write-1", content: "File created" },
          { type: "tool_result", tool_use_id: "read-1", content: "unrelated file body" },
        ],
      },
    },
  ];
  const chunks = messages.flatMap((m) => [
    ...claudeTraces(m, internal).map((trace) => ({ trace })),
    ...claudeActivities(m, pending).map((activity) => ({ activity })),
  ]);
  // Read and its result never leave the runtime as structured data.
  expect(JSON.stringify(chunks.filter((c: any) => c.activity))).not.toContain("unrelated file body");
  serveRuntime(chunks);
  const run = await runTurn(agent.id);
  const conversation = run.conversation_id!;
  const [output] = byKind(conversation, "output");
  expect(output.record.data).toMatchObject({ command: "ls -la", status: "exited" });
  expect(output.record.data.chunks[0].text).toBe("total 0\n");
  const [file] = byKind(conversation, "file_change");
  expect(file.record.data.files[0]).toMatchObject({ path: "notes.md", after: "# Notes\n" });
  expect(file.record.data.state).toBe("applied");
  const [plan] = byKind(conversation, "plan");
  expect(plan.record.data.steps[0]).toMatchObject({ title: "Write notes", status: "in_progress" });
});

it("bounds runtime payloads before they cross the NDJSON transport", () => {
  const huge = "x".repeat(300_000);
  const command = codexActivity({
    method: "item/completed",
    params: { item: { id: "c", type: "commandExecution", status: "completed", aggregatedOutput: "start" + huge } },
  })!;
  expect((command as any).params.item.aggregatedOutput).toHaveLength(48_001);
  const files = codexActivity({
    method: "item/completed",
    params: {
      item: {
        id: "f",
        type: "fileChange",
        status: "completed",
        changes: Array.from({ length: 150 }, (_, i) => ({ path: `f${i}.ts`, kind: { type: "update" }, diff: huge })),
      },
    },
  })!;
  const changes = (files as any).params.item.changes;
  expect(changes).toHaveLength(100);
  // Diffs past the per-event budget are omitted (shown as unavailable).
  expect(changes.filter((c: any) => c.diff === undefined).length).toBeGreaterThan(0);
  expect(JSON.stringify(files).length).toBeLessThan(2_000_000);
});

it("provider-key runs cannot inject structured results and report why", async () => {
  const connection = id();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,'alice','openai','Key',?,'connected',?,?)",
  ).run(connection, seal("fixture", "alice"), JSON.stringify([{ id: "fixture" }]), now());
  const agent = createAgent("alice", {
    name: "key-" + id().slice(0, 8),
    connectionId: connection,
    model: "fixture",
  });
  const restore = withTestAdapter("openai", {
    async models() {
      return [];
    },
    async *stream() {
      // A provider adapter is not Loop's executor; this must be ignored.
      yield { activity: codexActivity(codexTurn("turn")[2]) } as any;
      yield { text: "Done." };
    },
  });
  try {
    const run = await runTurn(agent.id);
    const conversation = run.conversation_id!;
    expect(byKind(conversation, "output")).toEqual([]);
    const [caps] = byKind(conversation, "capabilities");
    expect(caps.record.capabilities).toMatchObject({
      diffs: { state: "unsupported", reason: expect.stringContaining("tool broker") },
      output: { state: "unsupported", reason: expect.stringContaining("tool broker") },
      commands: { state: "unsupported", reason: expect.stringContaining("provider API key") },
    });
  } finally {
    restore();
  }
});
