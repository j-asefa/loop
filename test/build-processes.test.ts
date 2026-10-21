import { afterAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runningBuild } from "../src/shared/build";

const dir = mkdtempSync(join(tmpdir(), "loop-build-processes-"));
process.env.LOOP_DATA_DIR = dir;
const { db, now } = await import("../src/server/db");
const { observeProcess, currentBuilds } = await import("../src/server/deployments");
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

it("omits expired and stopped processes from reads without reconciliation", () => {
  const stopApi = observeProcess("api", runningBuild);
  const stopWorker = observeProcess("worker", runningBuild);
  try {
    expect(currentBuilds().map((instance) => instance.role).sort()).toEqual([
      "api",
      "worker",
    ]);
    db.prepare("UPDATE deployment_instances SET seen_at=? WHERE role='api'").run(
      now() - 60_000,
    );
    expect(currentBuilds().map((instance) => instance.role)).toEqual(["worker"]);
    stopWorker();
    expect(currentBuilds()).toEqual([]);
  } finally {
    stopApi();
    stopWorker();
  }
});
