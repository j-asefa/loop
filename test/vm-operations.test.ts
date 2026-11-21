import Database from "better-sqlite3";
import { beforeEach, expect, it } from "vitest";
import { applyMigrations } from "../src/server/migrations.js";
import { applyMigrationsThrough } from "./helpers/migrations.js";
import * as experimentPreviewsQueries from "../src/server/sql/experiment-previews.js";
import * as experimentVmsQueries from "../src/server/sql/experiment-vms.js";
import * as vmOperationsQueries from "../src/server/sql/vm-operations.js";
import {
  VM_OPERATION_MAX_CALL_MS,
  markStaleVmOperationsUncertain,
  transitionVm,
} from "../src/server/vm/machine.js";
import {
  vmOperationEffects,
  reconcileVmOperation,
  runVmOperation,
} from "../src/server/vm/operations.js";
import { VmProviderError, type VmStatus } from "../src/server/vm/provider.js";
import { authVolumeName } from "../src/server/vm/sailbox-image.js";
import { legalVmTransition } from "../src/shared/vm-state.js";

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
  effects?: Parameters<typeof runVmOperation>[4],
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
    // Receipt-only tests opt out of the create's local writes.
    effects ?? {},
  );

const createEffects = (experimentId: string, id: string) =>
  vmOperationEffects(
    db,
    { owner: "alice", experimentId, id, kind: "create", request: {} },
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

it("keeps each owner's experiments and operation ids apart", async () => {
  await create("op1", async () => ({ remoteId: "sb-1" }));
  let calls = 0;
  const call = async () => {
    calls += 1;
    return { remoteId: "sb-b" };
  };
  await expect(create("op9", call, { owner: "bob" })).rejects.toMatchObject({
    reason: "missing_experiment",
  });
  expect(calls).toBe(0);
  // Operation ids are scoped to the owner: bob's "op1" is his own receipt
  // and reveals nothing about alice's.
  experiment("bob", "exp2");
  expect(
    await create("op1", call, { owner: "bob", experimentId: "exp2" }),
  ).toMatchObject({ state: "succeeded", replayed: false });
  expect(calls).toBe(1);
  expect(vmOperationsQueries.byId(db, "alice", "op1")).toMatchObject({
    experiment_id: "exp1",
    result_json: '{"remoteId":"sb-1"}',
  });
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
// Reconciles once the original call can no longer be in flight; see
// reconcileSoon for the window before that.
const reconcile = (
  provider: Parameters<typeof reconcileVmOperation>[1],
  owner = "alice",
  operationId = "op1",
) => {
  time += VM_OPERATION_MAX_CALL_MS + 1;
  return reconcileSoon(provider, owner, operationId);
};
const reconcileSoon = (
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
  ).toEqual({
    outcome: "succeeded",
    result: { remoteId: "sb-7", status: "running" },
  });
  expect(experimentVmsQueries.byId(db, "alice", "exp1")).toMatchObject({
    remote_id: "sb-7",
    state: "running",
  });
  expect(vmOperationsQueries.byId(db, "alice", "op1")).toMatchObject({
    state: "succeeded",
    result_json: '{"remoteId":"sb-7","status":"running"}',
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

it("records a created VM's id and state in the same transaction as its receipt", async () => {
  expect(
    await create(
      "op1",
      async () => ({ remoteId: "sb-1", status: "running" }),
      {},
      createEffects("exp1", "op1"),
    ),
  ).toMatchObject({ state: "succeeded" });
  expect(experimentVmsQueries.byId(db, "alice", "exp1")).toMatchObject({
    remote_id: "sb-1",
    state: "running",
  });

  experiment("alice", "exp2");
  db.exec(
    "CREATE TRIGGER refuse_vm_state BEFORE UPDATE OF state ON experiment_vms BEGIN SELECT RAISE(ABORT, 'disk full'); END",
  );
  await expect(
    create(
      "op2",
      async () => ({ remoteId: "sb-2", status: "running" }),
      { experimentId: "exp2" },
      createEffects("exp2", "op2"),
    ),
  ).rejects.toThrow("disk full");
  // Nothing committed: the sweep and a reconcile take it from here.
  expect(vmOperationsQueries.byId(db, "alice", "op2")?.state).toBe("pending");
  expect(experimentVmsQueries.byId(db, "alice", "exp2")?.remote_id).toBeNull();
});

it("fails a create whose VM booted into failed, keeping its id so it can be destroyed", async () => {
  expect(
    await create(
      "op1",
      async () => ({
        remoteId: "sb-1",
        status: "failed",
        errorMessage: "image pull failed",
      }),
      {},
      createEffects("exp1", "op1"),
    ),
  ).toEqual({
    state: "failed",
    errorMessage: "image pull failed",
    replayed: false,
  });
  expect(experimentVmsQueries.byId(db, "alice", "exp1")).toMatchObject({
    remote_id: "sb-1",
    state: "failed",
    last_error: "image pull failed",
  });
  expect(vmOperationsQueries.byId(db, "alice", "op1")).toMatchObject({
    state: "failed",
    result_json: expect.stringContaining("sb-1"),
  });
});

it("reconciles a create whose only match failed as failed, adopting the VM", async () => {
  await uncertainCreate();
  expect(
    await reconcile(found({ remoteId: "sb-7", status: "failed" })),
  ).toMatchObject({ outcome: "failed" });
  expect(experimentVmsQueries.byId(db, "alice", "exp1")).toMatchObject({
    remote_id: "sb-7",
    state: "failed",
  });
});

it("does not settle on an absent effect while the original call may still be in flight", async () => {
  await uncertainCreate();
  expect(await reconcileSoon(found())).toEqual({
    outcome: "still_uncertain",
    reason: "the original call may still be in flight",
  });
  expect(vmOperationsQueries.byId(db, "alice", "op1")?.state).toBe("uncertain");
  // A VM that is already there settles at once.
  expect(
    await reconcileSoon(found({ remoteId: "sb-7", status: "running" })),
  ).toMatchObject({ outcome: "succeeded" });
});

it("fails the VM, not leaving it destroying, when an uncertain destroy did not happen", async () => {
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
  provider.statuses.set("sb-1", "running");
  expect(await reconcile(provider)).toMatchObject({ outcome: "failed" });
  expect(experimentVmsQueries.byId(db, "alice", "exp1")).toMatchObject({
    state: "failed",
    last_error:
      "The destroy did not finish; the provider reports the VM running",
  });
  expect(
    transitionVm(db, { owner: "alice", id: "exp1" }, "destroying", {
      now: clock(),
    }).changed,
  ).toBe(true);
});

it("refuses an experiment on another owner's folder or forked from another owner's experiment", () => {
  db.prepare(
    "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES('folder-bob','bob','project','b',1)",
  ).run();
  const base = {
    provider: "sailbox",
    autoApproveLocal: true,
    vcpuLimit: 4,
    memoryLimitGib: 16,
    diskLimitGib: 64,
    autoSleepSeconds: 900,
    sourceCheckpointId: null,
    cloneUrl: null,
    now: clock(),
  };
  expect(
    experimentVmsQueries.insert(db, {
      ...base,
      id: "x1",
      owner: "alice",
      folderId: "folder-bob",
      remoteName: "loop-exp-x1",
      sourceExperimentId: null,
    }),
  ).toBe(false);
  expect(
    experimentVmsQueries.insert(db, {
      ...base,
      id: "x2",
      owner: "bob",
      folderId: "folder-bob",
      remoteName: "loop-exp-x2",
      sourceExperimentId: "exp1",
    }),
  ).toBe(false);
  expect(experimentVmsQueries.byId(db, "bob", "x2")).toBeUndefined();
});

it("counts a lookup as too early when it started inside the in-flight window", async () => {
  await uncertainCreate();
  const created = time;
  const slow = {
    ...found(),
    async findByName() {
      // The answer arrives after the window, but the lookup began inside it.
      time = created + VM_OPERATION_MAX_CALL_MS + 10;
      return [];
    },
  };
  expect(await reconcileSoon(slow)).toEqual({
    outcome: "still_uncertain",
    reason: "the original call may still be in flight",
  });
  expect(vmOperationsQueries.byId(db, "alice", "op1")?.state).toBe("uncertain");
});

it("leaves a create uncertain while its VM is still starting", async () => {
  await uncertainCreate();
  for (const status of ["provisioning", "unknown", "terminating"] as const)
    expect(await reconcile(found({ remoteId: "sb-7", status }))).toMatchObject({
      outcome: "still_uncertain",
    });
  expect(experimentVmsQueries.byId(db, "alice", "exp1")?.remote_id).toBeNull();
});

async function uncertain(
  id: string,
  kind: "expose" | "unexpose" | "destroy",
  request: unknown,
) {
  const operation = { id, owner: "alice", experimentId: "exp1", kind, request };
  await runVmOperation(
    db,
    operation,
    async () => {
      throw new VmProviderError("uncertain", "timed out");
    },
    clock,
    vmOperationEffects(db, operation, clock),
  );
}

it("keeps preview rows in step when expose, unexpose and destroy are reconciled", async () => {
  await runningVm();
  await uncertain("op1", "expose", { port: 3000, label: "Demo" });
  const provider = found();
  provider.ports.set(3000, "https://p.example");
  provider.statuses.set("sb-1", "running");
  await reconcile(provider);
  expect(
    experimentPreviewsQueries.byPort(db, "alice", "exp1", 3000),
  ).toMatchObject({ url: "https://p.example", label: "Demo", active: 1 });

  await uncertain("op2", "unexpose", { port: 3000 });
  provider.ports.delete(3000);
  expect(await reconcile(provider, "alice", "op2")).toMatchObject({
    outcome: "succeeded",
  });
  expect(
    experimentPreviewsQueries.byPort(db, "alice", "exp1", 3000)?.active,
  ).toBe(0);

  experimentPreviewsQueries.upsert(db, {
    id: "pv2",
    owner: "alice",
    experimentId: "exp1",
    port: 4000,
    label: null,
    path: "/",
    url: "https://q.example",
    now: clock(),
  });
  transitionVm(db, { owner: "alice", id: "exp1" }, "destroying", {
    now: clock(),
  });
  await uncertain("op3", "destroy", {});
  provider.statuses.delete("sb-1");
  expect(await reconcile(provider, "alice", "op3")).toMatchObject({
    outcome: "succeeded",
  });
  expect(experimentVmsQueries.byId(db, "alice", "exp1")?.state).toBe(
    "destroyed",
  );
  expect(
    experimentPreviewsQueries
      .byExperiment(db, "alice", "exp1")
      .filter((preview) => preview.active === 1),
  ).toEqual([]);
});

it("fails a destroying VM when the provider refuses the destroy", async () => {
  await runningVm();
  transitionVm(db, { owner: "alice", id: "exp1" }, "destroying", {
    now: clock(),
  });
  const operation = {
    id: "op1",
    owner: "alice",
    experimentId: "exp1",
    kind: "destroy" as const,
    request: {},
  };
  expect(
    await runVmOperation(
      db,
      operation,
      async () => {
        throw new VmProviderError("refused", "Sailbox is locked", 409);
      },
      clock,
      vmOperationEffects(db, operation, clock),
    ),
  ).toMatchObject({ state: "failed" });
  expect(experimentVmsQueries.byId(db, "alice", "exp1")).toMatchObject({
    state: "failed",
    last_error: "Sailbox is locked",
  });
});

it("refuses a preview on another owner's experiment", () => {
  const preview = {
    id: "pv1",
    owner: "bob",
    experimentId: "exp1",
    port: 3000,
    label: null,
    path: "/",
    url: "https://evil.example",
    now: clock(),
  };
  expect(experimentPreviewsQueries.upsert(db, preview)).toBe(false);
  expect(
    experimentPreviewsQueries.upsert(db, { ...preview, owner: "alice" }),
  ).toBe(true);
  expect(experimentPreviewsQueries.byPort(db, "alice", "exp1", 3000)?.url).toBe(
    "https://evil.example",
  );
  expect(experimentPreviewsQueries.byExperiment(db, "bob", "exp1")).toEqual([]);
});

it("does not settle an uncertain unexpose from an absent port until the window has passed", async () => {
  await runningVm();
  await uncertain("op1", "unexpose", { port: 3000 });
  const provider = found();
  expect(await reconcileSoon(provider)).toEqual({
    outcome: "still_uncertain",
    reason: "the original call may still be in flight",
  });
  expect(await reconcile(provider)).toMatchObject({ outcome: "succeeded" });
});

it("keeps a create answered while its VM is still starting uncertain, then settles it by reconcile", async () => {
  expect(
    await create(
      "op1",
      async () => ({ remoteId: "sb-1", status: "provisioning" }),
      {},
      createEffects("exp1", "op1"),
    ),
  ).toEqual({ state: "uncertain", errorMessage: "The VM is provisioning" });
  // The id is provisional: it stays in the receipt, not on the VM.
  expect(experimentVmsQueries.byId(db, "alice", "exp1")).toMatchObject({
    remote_id: null,
    state: "provisioning",
  });
  expect(vmOperationsQueries.byId(db, "alice", "op1")?.result_json).toContain(
    "sb-1",
  );
  expect(
    await reconcileSoon(found({ remoteId: "sb-1", status: "running" })),
  ).toMatchObject({ outcome: "succeeded" });
  expect(experimentVmsQueries.byId(db, "alice", "exp1")?.state).toBe("running");
});

it("moves a failed VM to the asleep state a later create adopts", async () => {
  await uncertainCreate();
  await reconcile(found());
  expect(experimentVmsQueries.byId(db, "alice", "exp1")?.state).toBe("failed");
  expect(
    await create(
      "op2",
      async () => ({ remoteId: "sb-2", status: "sleeping" }),
      {},
      createEffects("exp1", "op2"),
    ),
  ).toMatchObject({ state: "succeeded" });
  expect(experimentVmsQueries.byId(db, "alice", "exp1")).toMatchObject({
    remote_id: "sb-2",
    state: "sleeping",
  });
});

it("gives each owner a separate auth volume", () => {
  expect(authVolumeName("alice")).toMatch(/^loop-auth-[0-9a-f]{16}$/);
  expect(authVolumeName("alice")).toBe(authVolumeName("alice"));
  expect(authVolumeName("alice")).not.toBe(authVolumeName("bob"));
});

it("lets a retry create a VM after a still-starting VM turned out absent", async () => {
  await create(
    "op1",
    async () => ({ remoteId: "sb-1", status: "provisioning" }),
    {},
    createEffects("exp1", "op1"),
  );
  expect(await reconcile(found())).toMatchObject({ outcome: "failed" });
  expect(
    await create(
      "op2",
      async () => ({ remoteId: "sb-2", status: "running" }),
      {},
      createEffects("exp1", "op2"),
    ),
  ).toMatchObject({ state: "succeeded" });
  expect(experimentVmsQueries.byId(db, "alice", "exp1")).toMatchObject({
    remote_id: "sb-2",
    state: "running",
  });
});

it("refuses another create once the experiment has its VM, without calling the provider", async () => {
  await create(
    "op1",
    async () => ({ remoteId: "sb-1", status: "failed", errorMessage: "boom" }),
    {},
    createEffects("exp1", "op1"),
  );
  let called = false;
  await expect(
    create("op2", async () => {
      called = true;
      return {};
    }),
  ).rejects.toMatchObject({ reason: "vm_exists" });
  expect(called).toBe(false);
});

it("records every live status the provider reports, such as a sleeping VM found paused", async () => {
  await runningVm();
  transitionVm(db, { owner: "alice", id: "exp1" }, "sleeping", {
    now: clock(),
  });
  const operation = {
    id: "op1",
    owner: "alice",
    experimentId: "exp1",
    kind: "resume" as const,
    request: {},
  };
  await runVmOperation(
    db,
    operation,
    async () => {
      throw new VmProviderError("uncertain", "timed out");
    },
    clock,
    vmOperationEffects(db, operation, clock),
  );
  const provider = found();
  provider.statuses.set("sb-1", "paused");
  expect(await reconcile(provider)).toMatchObject({ outcome: "failed" });
  expect(experimentVmsQueries.byId(db, "alice", "exp1")?.state).toBe("paused");
  const live = ["running", "sleeping", "paused"] as const;
  for (const from of live)
    for (const to of live)
      if (from !== to) expect(legalVmTransition(from, to)).toBe(true);
});

it("records a destroy sent while the VM was running as destroyed, not failed", async () => {
  await runningVm();
  const operation = {
    id: "op1",
    owner: "alice",
    experimentId: "exp1",
    kind: "destroy" as const,
    request: {},
  };
  await runVmOperation(
    db,
    operation,
    async () => null,
    clock,
    vmOperationEffects(db, operation, clock),
  );
  expect(experimentVmsQueries.byId(db, "alice", "exp1")?.state).toBe(
    "destroyed",
  );
});

it("refuses an operation on an experiment with no recorded VM", async () => {
  await expect(
    runVmOperation(
      db,
      {
        id: "op1",
        owner: "alice",
        experimentId: "exp1",
        kind: "sleep",
        request: {},
      },
      async () => null,
      clock,
    ),
  ).rejects.toMatchObject({ reason: "no_vm" });
});

it("records a create's VM by default, without the caller passing effects", async () => {
  await runVmOperation(
    db,
    {
      id: "op1",
      owner: "alice",
      experimentId: "exp1",
      kind: "create",
      request: {},
    },
    async () => ({ remoteId: "sb-1", status: "running" }),
    clock,
  );
  expect(experimentVmsQueries.byId(db, "alice", "exp1")).toMatchObject({
    remote_id: "sb-1",
    state: "running",
  });
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
