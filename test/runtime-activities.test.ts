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

// Legacy serializer fixtures cover bounded archived activity data.
// HAPI projection is tested at its active production boundary.
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
