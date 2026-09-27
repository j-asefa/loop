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
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  db.prepare("UPDATE runs SET state='cancelled' WHERE state='running'").run();
});
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function start(maxSeconds?: number, failure?: object) {
  const connection = id();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,'alice','codex','Fixture','','connected',?, ?,?)",
  ).run(
    connection,
    JSON.stringify([{ id: "fixture" }]),
    JSON.stringify({ authMode: "subscription" }),
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
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    expect(url).toBe("http://runtime.fixture/runtime");
    signal = init.signal!;
    return new Response(
      new ReadableStream({
        start(controller) {
          const emit = (event: object) =>
            controller.enqueue(
              new TextEncoder().encode(JSON.stringify(event) + "\n"),
            );
          const abort = () => controller.error(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          emit({ chunk: { text: "Saved partial. " } });
          finish = () => {
            signal.removeEventListener("abort", abort);
            if (failure) emit(failure);
            else {
              emit({ chunk: { text: "Completed after CI passed." } });
              emit({ done: true });
            }
            controller.close();
          };
          ready();
        },
      }),
    );
  });
  const result = executeAgent(run).then(
    (value) => ({ value, error: undefined }),
    (error) => ({ value: undefined, error }),
  );
  await began;
  await vi.advanceTimersByTimeAsync(0);
  return { run, result, finish, signal };
}

it("finishes a subscription run beyond 30 minutes without aborting its HTTP stream", async () => {
  const running = await start();
  await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
  expect(running.signal.aborted).toBe(false);
  running.finish();
  expect(await running.result).toEqual({ value: true, error: undefined });
  expect(
    db.prepare("SELECT result FROM runs WHERE id=?").get(running.run.id),
  ).toEqual({ result: "Saved partial. Completed after CI passed." });
  transition(running.run, "completed");
});

it("still cancels a subscription run after the former deadline and saves partial output", async () => {
  const running = await start();
  await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
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

it("persists a typed broker idle timeout through the subscription client and worker", async () => {
  const { IDLE_TIMEOUT_MESSAGE } = await import("../runtime/idle-deadline.mjs");
  const { tick } = await import("../src/server/worker");
  const running = await start(undefined, {
    code: "idle_timeout",
    error: "Untrusted provider text",
  });
  running.finish();
  const { error } = await running.result;
  expect(error).toMatchObject({ status: 408, message: IDLE_TIMEOUT_MESSAGE });
  db.prepare("UPDATE runs SET state='queued', worker_id=NULL WHERE id=?").run(
    running.run.id,
  );
  await tick(async (run) => {
    expect(run.id).toBe(running.run.id);
    throw error;
  });
  expect(
    db.prepare("SELECT state, error FROM runs WHERE id=?").get(running.run.id),
  ).toEqual({ state: "failed", error: IDLE_TIMEOUT_MESSAGE });
  expect(
    db
      .prepare(
        "SELECT content FROM messages WHERE run_id=? AND role='assistant'",
      )
      .get(running.run.id),
  ).toEqual({ content: "Saved partial. " });
});

it("keeps unknown broker errors generic", async () => {
  const running = await start(undefined, {
    code: "unknown",
    error: "Untrusted provider text",
  });
  running.finish();
  expect((await running.result).error).toMatchObject({
    status: 422,
    message: expect.stringContaining("Check sign-in"),
  });
});

it("retains typed runtime failures with redacted details", async () => {
  const running = await start(undefined, {
    code: "runtime_failure",
    error: "Codex turn failed: rate limit exceeded; Bearer private-auth-token",
  });
  running.finish();
  const { error } = await running.result;
  expect(error.message).toContain("rate limit exceeded");
  expect(error.message).not.toContain("private-auth-token");
});
