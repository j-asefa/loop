import { testDirectory } from "./helpers/test-workspace.js";
import { afterAll, expect, it } from "vitest";

testDirectory();

const { db, now } = await import("../src/server/db");
const { tick } = await import("../src/server/worker");
const experimentVmsQueries = await import("../src/server/sql/experiment-vms");
const vmOperationsQueries = await import("../src/server/sql/vm-operations");
const { VM_OPERATION_MAX_CALL_MS } = await import("../src/server/vm/machine");

afterAll(() => db.close());

// The worker tick is the production caller of the stale-receipt sweep.
it("marks a VM operation receipt left pending by a dead caller uncertain on the next worker tick", async () => {
  db.prepare(
    "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES('folder-w','owner-w','project','w',1)",
  ).run();
  experimentVmsQueries.insert(db, {
    id: "exp-w",
    owner: "owner-w",
    folderId: "folder-w",
    provider: "sailbox",
    remoteName: "loop-exp-w",
    autoApproveLocal: true,
    vcpuLimit: 4,
    memoryLimitGib: 16,
    diskLimitGib: 64,
    autoSleepSeconds: 900,
    sourceExperimentId: null,
    sourceCheckpointId: null,
    cloneUrl: null,
    now: now(),
  });
  for (const [id, age] of [
    ["stale", VM_OPERATION_MAX_CALL_MS + 60_000],
    ["fresh", 1_000],
  ] as const)
    vmOperationsQueries.insertPending(db, {
      id,
      owner: "owner-w",
      experimentId: "exp-w",
      kind: "create",
      requestDigest: "d",
      requestJson: "{}",
      now: now() - age,
    });

  await tick();

  expect(vmOperationsQueries.byId(db, "owner-w", "stale")).toMatchObject({
    state: "uncertain",
    error_message: "Loop stopped before the provider answered",
  });
  expect(vmOperationsQueries.byId(db, "owner-w", "fresh")?.state).toBe(
    "pending",
  );
});
