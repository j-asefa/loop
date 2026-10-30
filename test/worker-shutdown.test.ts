import { expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("does not claim when an already-started scheduling tick resumes after quiesce", async () => {
  vi.resetModules();
  const directory = mkdtempSync(join(tmpdir(), "loop55-worker-quiesce-"));
  vi.stubEnv("LOOP55_PROFILE", "server");
  vi.stubEnv("LOOP55_DATA_DIR", directory);
  const { db, changes } = await import("../src/server/db");
  const { enqueue } = await import("../src/server/queue");
  const sessions = await import("../src/server/mcp/sessions");
  let entered = false,
    release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(sessions, "closeFinishedSessions").mockImplementationOnce(() => {
    entered = true;
    return held;
  });
  const { startWorker } = await import("../src/server/worker");
  const run = enqueue("quiesce", "Must remain queued", "quiesce", {
    kind: "diagnostic",
  });
  const stop = startWorker();
  try {
    await expect.poll(() => entered).toBe(true);
    const corrupt = enqueue(
      "quiesce",
      "Already dispatched",
      "quiesce-corrupt",
      { kind: "diagnostic" },
    );
    const worker = db.prepare("SELECT id FROM worker_health LIMIT 1").get() as {
      id: string;
    };
    db.prepare(
      "UPDATE runs SET state='running',worker_id=?,payload=? WHERE id=?",
    ).run(worker.id, '{"reviewId":null}', corrupt.id);
    stop.quiesce();
    expect(
      db.prepare("SELECT state FROM runs WHERE id=?").get(corrupt.id),
    ).toEqual({ state: "interrupted" });
    expect(
      db
        .prepare("SELECT 1 FROM native_dispatch WHERE run_id=?")
        .get(corrupt.id),
    ).toBeUndefined();
    release();
    await stop();
    expect(
      db.prepare("SELECT state,worker_id FROM runs WHERE id=?").get(run.id),
    ).toEqual({ state: "queued", worker_id: null });
    expect(
      db
        .prepare(
          "SELECT count(*) n FROM events WHERE run_id=? AND type='running'",
        )
        .get(run.id),
    ).toEqual({ n: 0 });
  } finally {
    release();
    await stop();
    changes.close();
    db.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});
