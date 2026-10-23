import { expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { executeAgent } = vi.hoisted(() => ({ executeAgent: vi.fn() }));
vi.mock("../src/server/agent-runtime", () => ({ executeAgent }));
vi.mock("../src/server/search", () => ({ indexPending: async () => {} }));
vi.mock("../src/server/memory", async (original) => ({
  ...(await original<any>()),
  indexMemory: async () => {},
}));

it.each(["companion", "server"])(
  "%s schedules 32 running tasks and admits the 33rd only after a slot is released",
  async (profile) => {
    vi.resetModules();
    const dir = mkdtempSync(join(tmpdir(), "loop-worker-capacity-"));
    vi.stubEnv("LOOP_PROFILE", profile);
    vi.stubEnv("LOOP_DATA_DIR", dir);
    const { db, changes } = await import("../src/server/db");
    const { enqueue, transition } = await import("../src/server/queue");
    const { startWorker } = await import("../src/server/worker");
    const releases: (() => void)[] = [];
    const runs: Parameters<typeof transition>[0][] = [];
    executeAgent.mockImplementation((run) => {
      runs.push(run);
      return new Promise<void>((resolve) => releases.push(resolve));
    });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const subscriptions = changes.subscriberCount;
    const stop = startWorker();
    try {
      for (let n = 0; n < 33; n++)
        enqueue("capacity-test", "Hold this task", "task-" + n);
      // The two-second fallback is frozen: commits alone must fill the slots.
      await expect.poll(() => releases.length, { timeout: 1000 }).toBe(32);
      expect(
        db.prepare("SELECT count(*) n FROM runs WHERE state='queued'").get(),
      ).toEqual({ n: 1 });
      let terminalPublished = false;
      const unsubscribe = changes.subscribe("capacity-test", (events) => {
        terminalPublished ||= events.some(
          (event) => event.type === "completed",
        );
      });
      // A terminal row can precede tick's finally. All 32 execution slots are
      // still held when its publication wakes the scheduler.
      transition(runs[0], "completed");
      await expect.poll(() => terminalPublished).toBe(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(releases).toHaveLength(32);
      releases[0]();
      await expect.poll(() => releases.length, { timeout: 1000 }).toBe(33);
      unsubscribe();
      expect(
        db.prepare("SELECT count(*) n FROM runs WHERE state='running'").get(),
      ).toEqual({ n: 32 });
    } finally {
      releases.forEach((release) => release());
      await stop();
      expect(changes.subscriberCount).toBe(subscriptions);
      changes.close();
      vi.useRealTimers();
      vi.unstubAllEnvs();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

it("claims through the two-second fallback when local change wakes are unavailable", async () => {
  vi.resetModules();
  const dir = mkdtempSync(join(tmpdir(), "loop-worker-fallback-"));
  vi.stubEnv("LOOP_PROFILE", "server");
  vi.stubEnv("LOOP_DATA_DIR", dir);
  const { db, changes } = await import("../src/server/db");
  const { enqueue } = await import("../src/server/queue");
  const { startWorker } = await import("../src/server/worker");
  executeAgent.mockReset().mockResolvedValue(undefined);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const stop = startWorker();
  try {
    // Let the initial empty claim and subscription drain settle first.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    vi.spyOn(changes, "wake").mockImplementation(() => {});
    enqueue("fallback-test", "Claim without the signal", "fallback");
    await vi.advanceTimersByTimeAsync(1999);
    expect(executeAgent).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect.poll(() => executeAgent.mock.calls.length).toBe(1);
    await expect
      .poll(() => db.prepare("SELECT state FROM runs").get())
      .toEqual({ state: "completed" });
  } finally {
    await stop();
    changes.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});


it("wakes maintenance for mail and published artifacts while retaining its time-based pass", async () => {
  vi.resetModules();
  const directory = mkdtempSync(join(tmpdir(), "loop-worker-maintenance-"));
  vi.stubEnv("LOOP_PROFILE", "server"); vi.stubEnv("LOOP_DATA_DIR", directory);
  const { db, changes, emit } = await import("../src/server/db");
  const { enqueue } = await import("../src/server/queue");
  const notifications = await import("../src/server/notifications");
  let release = () => {};
  const delivery = vi.spyOn(notifications, "deliverNotifications").mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
  const { startWorker } = await import("../src/server/worker");
  const run = enqueue("maintenance", "Done", "maintenance");
  db.prepare("UPDATE runs SET state='completed' WHERE id=?").run(run.id);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const stop = startWorker();
  try {
    emit(run.owner_id, run.id, "artifact.published", { artifactId: "artifact" });
    emit(run.owner_id, run.id, "agent_mail.sent", { mailId: "mail", threadId: "thread", delivery: "new_turn" });
    await expect.poll(() => delivery.mock.calls.length).toBe(1);
    emit(run.owner_id, run.id, "agent_mail.held", { mailId: "mail", threadId: "thread" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(delivery).toHaveBeenCalledOnce();
    release();
    await expect.poll(() => delivery.mock.calls.length).toBe(2);
    release();
    await vi.advanceTimersByTimeAsync(3000);
    expect(delivery).toHaveBeenCalledTimes(3);
  } finally {
    release(); await stop(); changes.close(); db.close();
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});
