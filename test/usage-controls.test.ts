import { seedConnection, seedConversation, seedRun } from "./helpers/seed.js";
import { testDirectory } from "./helpers/test-workspace.js";
import { afterAll, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = testDirectory();

const { db, id, now, emit } = await import("../src/server/db");
const { createAgent } = await import("../src/server/domain");
const { submit } = await import("../src/server/agent-runtime");
const { tick } = await import("../src/server/worker");
const { setMaxConcurrentPerHarness, maxConcurrentPerHarness, autoWatchPrs } =
  await import("../src/server/mcp/approval-policy");
const { conversationUsage } = await import("../src/server/mobile-return");

afterAll(() => {
  db.close();
});

it("migrates historical mcp_preferences rows with opt-in PR watch and no harness cap", () => {
  const legacy = new Database(join(dir, "legacy-166.db"));
  try {
    legacy.exec(`
      CREATE TABLE mcp_preferences (
        owner_id TEXT PRIMARY KEY,
        approval_mode TEXT NOT NULL DEFAULT 'ask',
        agent_permission_mode TEXT
      );
      INSERT INTO mcp_preferences(owner_id, approval_mode, agent_permission_mode)
      VALUES ('legacy-owner', 'allow', 'acceptEdits');
    `);
    const sql = readFileSync(
      join(process.cwd(), "migrations", "166-usage-controls.sql"),
      "utf8",
    );
    legacy.exec(sql);
    const row = legacy
      .prepare("SELECT * FROM mcp_preferences WHERE owner_id='legacy-owner'")
      .get();
    expect(row).toEqual({
      owner_id: "legacy-owner",
      approval_mode: "allow",
      agent_permission_mode: "acceptEdits",
      auto_watch_prs: 0,
      max_concurrent_per_harness: null,
    });
  } finally {
    legacy.close();
  }
});

it("enforces maxConcurrentPerHarness per owner and harness without blocking other harnesses or owners", async () => {
  const ownerA = "cap-owner-a-" + id();
  const ownerB = "cap-owner-b-" + id();
  expect(autoWatchPrs(ownerA)).toBe(false);
  expect(maxConcurrentPerHarness(ownerA)).toBeNull();
  const makeHarnessConnection = (owner: string, harness: string) => {
    const cid = id();
    seedConnection(db, {
      id: cid,
      owner_id: owner,
      provider: harness === "claude" ? "anthropic" : "codex",
      secret: "",
      models: JSON.stringify([{ id: "native-default" }]),
      metadata: JSON.stringify({
        loopHarness: harness,
        authMode: "subscription",
      }),
      created_at: now(),
    });
    return cid;
  };
  const claudeA = makeHarnessConnection(ownerA, "claude");
  const codexA = makeHarnessConnection(ownerA, "codex");
  const claudeB = makeHarnessConnection(ownerB, "claude");
  const agentClaudeA1 = createAgent(ownerA, {
    name: "ca1-" + id().slice(0, 6),
    connectionId: claudeA,
    model: "native-default",
  });
  const agentClaudeA2 = createAgent(ownerA, {
    name: "ca2-" + id().slice(0, 6),
    connectionId: claudeA,
    model: "native-default",
  });
  const agentCodexA = createAgent(ownerA, {
    name: "xa1-" + id().slice(0, 6),
    connectionId: codexA,
    model: "native-default",
  });
  const agentClaudeB = createAgent(ownerB, {
    name: "cb1-" + id().slice(0, 6),
    connectionId: claudeB,
    model: "native-default",
  });
  setMaxConcurrentPerHarness(ownerA, 1);
  const runA1 = submit(ownerA, {
    agentId: agentClaudeA1.id,
    input: "First claude task",
    idempotencyKey: id(),
  });
  const runA2 = submit(ownerA, {
    agentId: agentClaudeA2.id,
    input: "Second claude task",
    idempotencyKey: id(),
  });
  const runCodex = submit(ownerA, {
    agentId: agentCodexA.id,
    input: "Parallel codex task",
    idempotencyKey: id(),
  });
  const runB = submit(ownerB, {
    agentId: agentClaudeB.id,
    input: "Other owner claude task",
    idempotencyKey: id(),
  });

  // Claim runA1 and hold it open while checking other claims.
  let releaseA1!: () => void;
  const holdA1 = new Promise<void>((resolve) => {
    releaseA1 = resolve;
  });
  const claimed: string[] = [];
  const firstTick = tick(async (run) => {
    claimed.push(run.id);
    if (run.id === runA1.id) await holdA1;
    return { kind: "finished" };
  });
  // Wait briefly for runA1 to be leased.
  for (let i = 0; i < 20 && !claimed.includes(runA1.id); i++)
    await new Promise((r) => setTimeout(r, 10));
  expect(claimed).toEqual([runA1.id]);

  // While runA1 is running on Claude for ownerA:
  // - runCodex (different harness for ownerA) claims immediately
  // - runB (different owner on Claude) claims immediately
  // - runA2 (second Claude run for ownerA) stays queued!
  expect(
    await tick(async (run) => {
      claimed.push(run.id);
      return { kind: "finished" };
    }),
  ).toBe(true);
  expect(
    await tick(async (run) => {
      claimed.push(run.id);
      return { kind: "finished" };
    }),
  ).toBe(true);
  expect(claimed).toContain(runCodex.id);
  expect(claimed).toContain(runB.id);
  expect(claimed).not.toContain(runA2.id);

  // Another tick cannot claim runA2 while runA1 is active.
  expect(
    await tick(async (run) => {
      claimed.push(run.id);
      return { kind: "finished" };
    }),
  ).toBe(false);
  expect(claimed).not.toContain(runA2.id);

  // Once runA1 completes, runA2 claims on the next tick.
  releaseA1();
  await firstTick;
  expect(
    await tick(async (run) => {
      claimed.push(run.id);
      return { kind: "finished" };
    }),
  ).toBe(true);
  expect(claimed).toContain(runA2.id);
});

it("aggregates cached input tokens from native usage and provider receipts while omitting zero values", () => {
  const owner = "cache-owner-" + id();
  const cid = id();
  const rNative = id();
  const rAnthropic = id();
  const rOpenai = id();
  const rLegacy = id();
  seedConversation(db, {
    id: cid,
    owner_id: owner,
    title: "Cache visibility",
    created_at: now(),
  });
  for (const runId of [rNative, rAnthropic, rOpenai, rLegacy])
    seedRun(db, {
      id: runId,
      owner_id: owner,
      conversation_id: cid,
      input: "hi",
      state: "completed",
      idempotency_key: runId,
      payload: "{}",
      created_at: now(),
      updated_at: now(),
    });
  emit(owner, rNative, "native.usage", {
    usage: { input_tokens: 10000, output_tokens: 200, cache_read_tokens: 9000 },
  });
  emit(owner, rAnthropic, "provider.receipt", {
    externalId: "msg_1",
    usage: {
      input_tokens: 5000,
      output_tokens: 100,
      cache_read_input_tokens: 4000,
    },
  });
  emit(owner, rOpenai, "provider.receipt", {
    externalId: "resp_1",
    usage: {
      input_tokens: 3000,
      output_tokens: 50,
      input_tokens_details: { cached_tokens: 1500 },
    },
  });
  emit(owner, rLegacy, "native.usage", {
    usage: { input_tokens: 400, output_tokens: 20 },
  });
  const usage = conversationUsage(owner, cid);
  expect(usage.runs[rNative]).toEqual({
    input_tokens: 10000,
    output_tokens: 200,
    cache_read_tokens: 9000,
  });
  expect(usage.runs[rAnthropic]).toEqual({
    input_tokens: 5000,
    output_tokens: 100,
    cache_read_tokens: 4000,
  });
  expect(usage.runs[rOpenai]).toEqual({
    input_tokens: 3000,
    output_tokens: 50,
    cache_read_tokens: 1500,
  });
  // Legacy runs with no cached tokens retain the exact 2-key shape.
  expect(usage.runs[rLegacy]).toEqual({ input_tokens: 400, output_tokens: 20 });
  expect(usage.total).toEqual({
    input_tokens: 18400,
    output_tokens: 370,
    cache_read_tokens: 14500,
  });
});
