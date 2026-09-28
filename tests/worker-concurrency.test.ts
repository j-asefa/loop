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
    const { db } = await import("../src/server/db");
    const { enqueue } = await import("../src/server/queue");
    const { startWorker } = await import("../src/server/worker");
    const releases: (() => void)[] = [];
    executeAgent.mockImplementation(
      () => new Promise<void>((resolve) => releases.push(resolve)),
    );
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const stop = startWorker();
    try {
      for (let n = 0; n < 33; n++)
        enqueue("capacity-test", "Hold this task", "task-" + n);
      // Exercise the actual scheduling interval and durable claim path.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(releases).toHaveLength(32);
      expect(
        db.prepare("SELECT count(*) n FROM runs WHERE state='queued'").get(),
      ).toEqual({ n: 1 });
      releases[0]();
      await vi.advanceTimersByTimeAsync(1000);
      expect(releases).toHaveLength(33);
      expect(
        db.prepare("SELECT count(*) n FROM runs WHERE state='running'").get(),
      ).toEqual({ n: 32 });
    } finally {
      releases.forEach((release) => release());
      await stop();
      vi.useRealTimers();
      vi.unstubAllEnvs();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
