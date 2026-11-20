import Database from "better-sqlite3";
import { beforeEach, expect, it } from "vitest";
import { applyMigrations } from "../src/server/migrations.js";
import { applyMigrationsThrough } from "./helpers/migrations.js";
import * as experimentVmsQueries from "../src/server/sql/experiment-vms.js";
import * as vmOperationsQueries from "../src/server/sql/vm-operations.js";
import {
  VM_OPERATION_MAX_CALL_MS,
  markStaleVmOperationsUncertain,
  transitionVm,
} from "../src/server/vm/machine.js";
import {
  reconcileVmOperation,
  runVmOperation,
} from "../src/server/vm/operations.js";
import { VmProviderError, type VmStatus } from "../src/server/vm/provider.js";

// Fixture coverage: an in-memory database with the production migrations and
// a scripted provider. No Sailbox is contacted.

let db: Database.Database;
let time = 1_000;
const clock = () => ++time;

function experiment(owner: string, id: string) {
  db.prepare(
    "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES(?,?,'project',?,1)",
  ).run(`folder-${id}`, owner, id);
  experimentVmsQueries.insert(db, {
    id,
    owner,
    folderId: `folder-${id}`,
    provider: "sailbox",
    remoteName: `loop-exp-${id}`,
    autoApproveLocal: true,
    vcpuLimit: 4,
    memoryLimitGib: 16,
    diskLimitGib: 64,
    autoSleepSeconds: 900,
    sourceExperimentId: null,
    sourceCheckpointId: null,
    cloneUrl: null,
    now: clock(),
  });
}

const create = (
  id: string,
  call: () => Promise<unknown>,
  overrides: { owner?: string; experimentId?: string; request?: unknown } = {},
) =>
  runVmOperation(
    db,
    {
      id,
      owner: overrides.owner ?? "alice",
      experimentId: overrides.experimentId ?? "exp1",
      kind: "create",
      request: overrides.request ?? { name: "loop-exp-exp1" },
    },
    call,
    clock,
  );

// A read-only provider for reconcile: VMs by name, statuses by id and
// published ports. Every lookup is counted.
const found = (...matches: { remoteId: string; status: VmStatus }[]) => ({
  calls: 0,
  statuses: new Map<string, VmStatus>(),
  ports: new Map<number, string>(),
  async findByName() {
    this.calls += 1;
    return matches;
  },
  async get(remoteId: string) {
    this.calls += 1;
    const status = this.statuses.get(remoteId);
    return status ? { status } : null;
  },
  async getHttpPort(_remoteId: string, port: number) {
    this.calls += 1;
    const url = this.ports.get(port);
    return url ? { url } : null;
  },
});

// Migrating once and copying the image keeps each test's database fresh.
const migrated = (() => {
  const template = new Database(":memory:");
  applyMigrations(template);
  const image = template.serialize();
  template.close();
  return image;
})();

beforeEach(() => {
  db = new Database(migrated);
  db.pragma("foreign_keys=ON");
  experiment("alice", "exp1");
});

it("calls the provider once and replays the stored result for the same id", async () => {
  let calls = 0;
  const call = async () => ({ remoteId: `sb-${++calls}` });
  expect(await create("op1", call)).toEqual({
    state: "succeeded",
    result: { remoteId: "sb-1" },
    replayed: false,
  });
  expect(await create("op1", call)).toEqual({
    state: "succeeded",
    result: { remoteId: "sb-1" },
    replayed: true,
  });
  expect(calls).toBe(1);
});

it("refuses an id reused for a different request without calling the provider", async () => {
  await create("op1", async () => ({}));
  let called = false;
  await expect(
    create(
      "op1",
      async () => {
        called = true;
      },
      { request: { name: "another" } },
    ),
  ).rejects.toMatchObject({ reason: "key_conflict" });
  expect(called).toBe(false);
});

it("writes the pending receipt before the provider is called", async () => {
  let seen: string | undefined;
  await create("op1", async () => {
    seen = vmOperationsQueries.byId(db, "alice", "op1")?.state;
    return {};
  });
  expect(seen).toBe("pending");
});

it("records a provider refusal as failed and an unobserved outcome as uncertain", async () => {
  expect(
    await create("op1", async () => {
      throw new VmProviderError("refused", "quota exceeded", 402);
    }),
  ).toMatchObject({ state: "failed", errorMessage: "quota exceeded" });
  expect(
    await create("op2", async () => {
      throw new VmProviderError("uncertain", "timed out");
    }),
  ).toEqual({ state: "uncertain", errorMessage: "timed out" });
});

it("treats an error that is not a provider answer as uncertain", async () => {
  expect(
    await create("op1", async () => {
      throw new TypeError("adapter bug");
    }),
  ).toEqual({ state: "uncertain", errorMessage: "adapter bug" });
});

it("does not call the provider again for an uncertain operation or start another beside it", async () => {
  await create("op1", async () => {
    throw new VmProviderError("uncertain", "socket closed");
  });
  let calls = 0;
  const call = async () => {
    calls += 1;
    return {};
  };
  expect(await create("op1", call)).toEqual({
    state: "uncertain",
    errorMessage: "socket closed",
  });
  await expect(create("op2", call)).rejects.toMatchObject({
    reason: "unsettled_operation",
  });
  expect(calls).toBe(0);
});

it("keeps another owner's experiment and operation ids out of reach", async () => {
  await create("op1", async () => ({ remoteId: "sb-1" }));
  let calls = 0;
  const call = async () => {
    calls += 1;
    return {};
  };
  await expect(create("op9", call, { owner: "bob" })).rejects.toMatchObject({
    reason: "missing_experiment",
  });
  experiment("bob", "exp2");
  await expect(
    create("op1", call, { owner: "bob", experimentId: "exp2" }),
  ).rejects.toMatchObject({ reason: "key_conflict" });
  expect(calls).toBe(0);
  expect(vmOperationsQueries.byId(db, "bob", "op1")).toBeUndefined();
  expect(
    transitionVm(db, { owner: "bob", id: "exp1" }, "running", { now: clock() }),
  ).toEqual({ changed: false, reason: "missing" });
});

it("marks a receipt uncertain only once no live call could still be waiting on it", () => {
  vmOperationsQueries.insertPending(db, {
    id: "op1",
    owner: "alice",
    experimentId: "exp1",
    kind: "create",
    requestDigest: "d",
    requestJson: "{}",
    now: time,
  });
  const created = time;
  expect(
    markStaleVmOperationsUncertain(db, created + VM_OPERATION_MAX_CALL_MS),
  ).toBe(0);
  expect(vmOperationsQueries.byId(db, "alice", "op1")?.state).toBe("pending");
  expect(
    markStaleVmOperationsUncertain(db, created + VM_OPERATION_MAX_CALL_MS + 1),
  ).toBe(1);
  expect(vmOperationsQueries.byId(db, "alice", "op1")?.state).toBe("uncertain");
});

it("lets a late answer settle a receipt the sweep marked uncertain", async () => {
  let answer!: (value: unknown) => void;
  const outcome = create(
    "op1",
    () => new Promise((resolve) => (answer = resolve)),
  );
  await new Promise((resolve) => setImmediate(resolve));
  markStaleVmOperationsUncertain(db, time + VM_OPERATION_MAX_CALL_MS + 1);
  answer({ remoteId: "sb-late" });
  expect(await outcome).toMatchObject({ state: "succeeded" });
  expect(vmOperationsQueries.byId(db, "alice", "op1")?.state).toBe("succeeded");
});

async function uncertainCreate() {
  await create("op1", async () => {
    throw new VmProviderError("uncertain", "timed out");
  });
}
const reconcile = (
  provider: Parameters<typeof reconcileVmOperation>[1],
  owner = "alice",
  operationId = "op1",
) =>
  reconcileVmOperation(
    db,
    provider,
    { owner, operationId, appId: "app" },
    clock,
  );

it("adopts the one VM that carries the experiment's name", async () => {
  await uncertainCreate();
  expect(
    await reconcile(found({ remoteId: "sb-7", status: "running" })),
  ).toEqual({ outcome: "succeeded", result: { remoteId: "sb-7" } });
  expect(experimentVmsQueries.byId(db, "alice", "exp1")).toMatchObject({
    remote_id: "sb-7",
    state: "running",
  });
  expect(vmOperationsQueries.byId(db, "alice", "op1")).toMatchObject({
    state: "succeeded",
    result_json: '{"remoteId":"sb-7"}',
  });
});

it("fails the operation when the provider has no such VM, allowing a new one", async () => {
  await uncertainCreate();
  expect(await reconcile(found())).toMatchObject({ outcome: "failed" });
  expect(experimentVmsQueries.byId(db, "alice", "exp1")?.state).toBe("failed");
  expect(await create("op2", async () => ({ remoteId: "sb-8" }))).toMatchObject(
    { state: "succeeded" },
  );
});

it("stays uncertain when the lookup fails, is ambiguous, or comes from another owner", async () => {
  await uncertainCreate();
  expect(
    await reconcile({
      ...found(),
      async findByName() {
        throw new VmProviderError("uncertain", "list timed out");
      },
    }),
  ).toEqual({ outcome: "still_uncertain", reason: "list timed out" });
  expect(
    await reconcile(
      found(
        { remoteId: "sb-1", status: "running" },
        { remoteId: "sb-2", status: "sleeping" },
      ),
    ),
  ).toMatchObject({ outcome: "still_uncertain" });
  const other = found({ remoteId: "sb-1", status: "running" });
  expect(await reconcile(other, "bob")).toMatchObject({
    outcome: "still_uncertain",
  });
  expect(other.calls).toBe(0);
  expect(vmOperationsQueries.byId(db, "alice", "op1")?.state).toBe("uncertain");
  expect(experimentVmsQueries.byId(db, "alice", "exp1")?.remote_id).toBeNull();
});

it("does not adopt a VM when another reconcile settled the receipt during the lookup", async () => {
  await uncertainCreate();
  const racing = {
    ...found(),
    async findByName() {
      // The other reconcile wins while this lookup is out.
      await reconcile(found());
      return [{ remoteId: "sb-9", status: "running" as const }];
    },
  };
  expect(await reconcile(racing)).toEqual({
    outcome: "still_uncertain",
    reason: "settled concurrently",
  });
  expect(experimentVmsQueries.byId(db, "alice", "exp1")).toMatchObject({
    remote_id: null,
    state: "failed",
  });
  expect(vmOperationsQueries.byId(db, "alice", "op1")?.state).toBe("failed");
});

it("returns the stored outcome when a late answer contradicts a reconciled receipt", async () => {
  let answer!: (value: unknown) => void;
  const outcome = create(
    "op1",
    () => new Promise((resolve) => (answer = resolve)),
  );
  await new Promise((resolve) => setImmediate(resolve));
  markStaleVmOperationsUncertain(db, time + VM_OPERATION_MAX_CALL_MS + 1);
  expect(await reconcile(found())).toMatchObject({ outcome: "failed" });
  answer({ remoteId: "sb-late" });
  const late = await outcome;
  expect(late).toMatchObject({ state: "failed", replayed: true });
  expect(await create("op1", async () => ({}))).toEqual(late);
});

it("adopts a VM found asleep, and settles its receipt and state together", async () => {
  await uncertainCreate();
  expect(
    await reconcile(found({ remoteId: "sb-7", status: "sleeping" })),
  ).toMatchObject({ outcome: "succeeded" });
  expect(experimentVmsQueries.byId(db, "alice", "exp1")).toMatchObject({
    remote_id: "sb-7",
    state: "sleeping",
  });
});

it("rolls the adoption back when the VM state cannot be written", async () => {
  await uncertainCreate();
  db.exec(
    "CREATE TRIGGER refuse_vm_state BEFORE UPDATE OF state ON experiment_vms BEGIN SELECT RAISE(ABORT, 'disk full'); END",
  );
  await expect(
    reconcile(found({ remoteId: "sb-7", status: "running" })),
  ).rejects.toThrow("disk full");
  expect(vmOperationsQueries.byId(db, "alice", "op1")?.state).toBe("uncertain");
  expect(experimentVmsQueries.byId(db, "alice", "exp1")?.remote_id).toBeNull();
});

async function runningVm(remoteId = "sb-1") {
  await create("op0", async () => ({ remoteId }));
  experimentVmsQueries.adoptRemote(db, "alice", "exp1", remoteId);
  transitionVm(db, { owner: "alice", id: "exp1" }, "running", { now: clock() });
}

it("reconciles an uncertain expose from the published port, unblocking the next operation", async () => {
  await runningVm();
  await runVmOperation(
    db,
    {
      id: "op1",
      owner: "alice",
      experimentId: "exp1",
      kind: "expose",
      request: { port: 3000 },
    },
    async () => {
      throw new VmProviderError("uncertain", "timed out");
    },
    clock,
  );
  const provider = found();
  provider.ports.set(3000, "https://p.example");
  expect(await reconcile(provider)).toEqual({
    outcome: "succeeded",
    result: { url: "https://p.example" },
  });
  expect(
    await runVmOperation(
      db,
      {
        id: "op2",
        owner: "alice",
        experimentId: "exp1",
        kind: "destroy",
        request: {},
      },
      async () => null,
      clock,
    ),
  ).toMatchObject({ state: "succeeded" });
});

it("reconciles an uncertain destroy from the VM's status", async () => {
  await runningVm();
  transitionVm(db, { owner: "alice", id: "exp1" }, "destroying", {
    now: clock(),
  });
  await runVmOperation(
    db,
    {
      id: "op1",
      owner: "alice",
      experimentId: "exp1",
      kind: "destroy",
      request: {},
    },
    async () => {
      throw new VmProviderError("uncertain", "timed out");
    },
    clock,
  );
  const provider = found();
  provider.statuses.set("sb-1", "terminating");
  expect(await reconcile(provider)).toMatchObject({
    outcome: "still_uncertain",
  });
  provider.statuses.delete("sb-1");
  expect(await reconcile(provider)).toMatchObject({ outcome: "succeeded" });
  expect(experimentVmsQueries.byId(db, "alice", "exp1")?.state).toBe(
    "destroyed",
  );
});

it("reports an uncertain sleep that did not happen as failed, so it can be asked for again", async () => {
  await runningVm();
  await runVmOperation(
    db,
    {
      id: "op1",
      owner: "alice",
      experimentId: "exp1",
      kind: "sleep",
      request: {},
    },
    async () => {
      throw new VmProviderError("uncertain", "timed out");
    },
    clock,
  );
  const provider = found();
  provider.statuses.set("sb-1", "running");
  expect(await reconcile(provider)).toMatchObject({ outcome: "failed" });
  expect(experimentVmsQueries.byId(db, "alice", "exp1")?.state).toBe("running");
});

it("refuses illegal and stale VM transitions", () => {
  const vm = { owner: "alice", id: "exp1" };
  expect(transitionVm(db, vm, "destroyed", { now: clock() })).toEqual({
    changed: false,
    reason: "illegal",
    from: "provisioning",
  });
  expect(transitionVm(db, vm, "running", { now: clock() }).changed).toBe(true);
  expect(
    transitionVm(db, vm, "destroying", {
      expected: "sleeping",
      now: clock(),
    }),
  ).toEqual({ changed: false, reason: "illegal", from: "running" });
  transitionVm(db, vm, "destroying", { now: clock() });
  transitionVm(db, vm, "destroyed", { now: clock() });
  const row = experimentVmsQueries.byId(db, "alice", "exp1");
  expect(row?.state).toBe("destroyed");
  expect(row?.destroyed_at).toBeGreaterThan(0);
  expect(transitionVm(db, vm, "running", { now: clock() }).changed).toBe(false);
});

it("adds the experiment tables to a database a released version wrote, leaving its rows alone", () => {
  const upgrade = new Database(":memory:");
  upgrade.pragma("foreign_keys=ON");
  applyMigrationsThrough(upgrade, 166);
  upgrade
    .prepare(
      "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES('f1','alice','project','Notes',1)",
    )
    .run();
  applyMigrations(upgrade);
  expect(upgrade.prepare("SELECT id,name FROM folders").all()).toEqual([
    { id: "f1", name: "Notes" },
  ]);
  for (const table of [
    "vm_provider_configs",
    "experiment_vms",
    "experiment_previews",
    "vm_operations",
  ])
    expect(upgrade.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual(
      { n: 0 },
    );
  upgrade.close();
});
