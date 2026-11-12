import { afterAll, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runningBuild } from "../src/shared/build";

const dir = mkdtempSync(join(tmpdir(), "loop-build-processes-"));
process.env.LOOP_DATA_DIR = dir;
const { db, now } = await import("../src/server/db");
const { observeProcess, currentBuilds } =
  await import("../src/server/deployments");
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

it("skips a locked heartbeat without blocking or crashing, expires it, and resumes next tick", () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const contender = new Database(join(dir, "loop.db"));
  const stop = observeProcess("api", runningBuild);
  const before = currentBuilds()[0].observedAt;
  const timeout = db.pragma("busy_timeout", { simple: true });
  try {
    contender.exec("BEGIN IMMEDIATE");
    const start = performance.now();
    expect(() => vi.advanceTimersByTime(25_000)).not.toThrow();
    expect(performance.now() - start).toBeLessThan(500);
    expect(currentBuilds()).toEqual([]);
    expect(warning).toHaveBeenCalledOnce();
    expect(db.pragma("busy_timeout", { simple: true })).toBe(timeout);
    expect(
      (
        db
          .prepare(
            "SELECT seen_at FROM deployment_instances WHERE stopped_at IS NULL",
          )
          .get() as any
      ).seen_at,
    ).toBe(before);
    contender.exec("ROLLBACK");
    vi.advanceTimersByTime(5000);
    expect(currentBuilds()).toHaveLength(1);
    expect(currentBuilds()[0].observedAt).toBeGreaterThan(before);
    contender.exec("BEGIN IMMEDIATE");
    expect(stop).not.toThrow();
    expect(warning).toHaveBeenCalledTimes(2);
    contender.exec("ROLLBACK");
    vi.advanceTimersByTime(25_000);
    expect(currentBuilds()).toEqual([]);
  } finally {
    if (contender.inTransaction) contender.exec("ROLLBACK");
    stop();
    contender.close();
    warning.mockRestore();
    vi.useRealTimers();
  }
});

it("omits expired and stopped processes from reads without reconciliation", () => {
  const stopApi = observeProcess("api", runningBuild);
  const stopWorker = observeProcess("worker", runningBuild);
  try {
    expect(
      currentBuilds()
        .map((instance) => instance.role)
        .sort(),
    ).toEqual(["api", "worker"]);
    db.prepare(
      "UPDATE deployment_instances SET seen_at=? WHERE role='api'",
    ).run(now() - 60_000);
    expect(currentBuilds().map((instance) => instance.role)).toEqual([
      "worker",
    ]);
    stopWorker();
    expect(currentBuilds()).toEqual([]);
  } finally {
    stopApi();
    stopWorker();
  }
});

it("propagates non-contention heartbeat failures and restores the connection timeout", () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  const stop = observeProcess("worker", runningBuild);
  const timeout = db.pragma("busy_timeout", { simple: true });
  try {
    db.exec(
      "CREATE TEMP TRIGGER refuse_heartbeat BEFORE UPDATE ON deployment_instances BEGIN SELECT RAISE(ABORT, 'heartbeat failed'); END",
    );
    expect(() => vi.advanceTimersByTime(5000)).toThrow("heartbeat failed");
    expect(db.pragma("busy_timeout", { simple: true })).toBe(timeout);
  } finally {
    db.exec("DROP TRIGGER IF EXISTS refuse_heartbeat");
    stop();
    vi.useRealTimers();
  }
});
