import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "loop-run-duration-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
process.env.LOOP_RUNTIME_URL = "http://runtime.fixture";
process.env.LOOP_RUNTIME_TOKEN =
  "duration-fixture-token-with-at-least-32-characters";
const { db, id, now } = await import("../src/server/db");
const { createAgent } = await import("../src/server/domain");
const { submit, executeAgent } = await import("../src/server/agent-runtime");
const { seal } = await import("../src/server/secrets");
const { withTestAdapter } = await import("../src/server/providers");
let restore: (() => void) | undefined;
const { claim, transition } = await import("../src/server/queue");

beforeEach(() => {
  vi.useFakeTimers();
  // AbortSignal.timeout uses native timers, so include it in the test clock.
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("Fixture timeout")), ms);
    return controller.signal;
  });
});
afterEach(() => {
  restore?.();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  db.prepare("UPDATE runs SET state='cancelled' WHERE state='running'").run();
});
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function start(maxSeconds?: number) {
  const connection = id();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,'alice','openai','Fixture',?,'connected',?, ?,?)",
  ).run(
    connection,
    seal("fixture", "alice"),
    JSON.stringify([{ id: "fixture" }]),
    "{}",
    now(),
  );
  const agent = createAgent("alice", {
    name: "duration-" + id().slice(0, 8),
    connectionId: connection,
    model: "fixture",
  });
  const submitted = submit("alice", {
    agentId: agent.id,
    input: "Finish a long coding task",
    idempotencyKey: id(),
  });
  const run = claim("duration-worker")!;
  expect(run.id).toBe(submitted.id);
  if (maxSeconds !== undefined) {
    run.payload = JSON.stringify({ ...JSON.parse(run.payload), maxSeconds });
    db.prepare("UPDATE runs SET payload=? WHERE id=?").run(run.payload, run.id);
  }
  let finish!: () => void;
  let signal!: AbortSignal;
  let ready!: () => void;
  const began = new Promise<void>((resolve) => {
    ready = resolve;
  });
  restore = withTestAdapter("openai", {
    async models() {
      return [];
    },
    async *stream(_secret, input) {
      signal = input.signal;
      yield { text: "Saved partial. " };
      await new Promise<void>((resolve, reject) => {
        finish = resolve;
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
        ready();
      });
      yield { text: "Completed after CI passed." };
    },
  });
  const result = executeAgent(run).then(
    (value) => ({ value, error: undefined }),
    (error) => ({ value: undefined, error }),
  );
  await began;
  await vi.advanceTimersByTimeAsync(0);
  return { run, result, finish, signal };
}

it("honors a one-hour API budget beyond the default three minutes without aborting its provider stream", async () => {
  const running = await start(3600);
  await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
  expect(running.signal.aborted).toBe(false);
  running.finish();
  expect(await running.result).toEqual({ value: true, error: undefined });
  expect(
    db.prepare("SELECT result FROM runs WHERE id=?").get(running.run.id),
  ).toEqual({ result: "Saved partial. Completed after CI passed." });
  transition(running.run, "completed");
});

it("still cancels an API run during an extended budget and saves partial output", async () => {
  const running = await start(3600);
  await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
  expect(running.signal.aborted).toBe(false);
  transition(running.run, "cancelled");
  await vi.advanceTimersByTimeAsync(300);
  expect(await running.result).toEqual({ value: false, error: undefined });
  expect(running.signal.aborted).toBe(true);
  expect(
    db
      .prepare(
        "SELECT content FROM messages WHERE run_id=? AND role='assistant'",
      )
      .get(running.run.id),
  ).toEqual({ content: "Saved partial. " });
});

it("honors an explicit workflow time limit and reports the actual reason", async () => {
  const running = await start(60);
  await vi.advanceTimersByTimeAsync(60000);
  expect((await running.result).error).toMatchObject({
    status: 408,
    message: expect.stringContaining("configured 60-second execution limit"),
  });
  expect(running.signal.aborted).toBe(true);
  expect(
    db
      .prepare(
        "SELECT content FROM messages WHERE run_id=? AND role='assistant'",
      )
      .get(running.run.id),
  ).toEqual({ content: "Saved partial. " });
});

it("treats a legacy zero budget as the default instead of aborting immediately", async () => {
  const running = await start(0);
  await vi.advanceTimersByTimeAsync(1000);
  expect(running.signal.aborted).toBe(false);
  running.finish();
  expect(await running.result).toEqual({ value: true, error: undefined });
  transition(running.run, "completed");
});
