import { expect, it, vi } from "vitest";
import {
  createReadExecutor,
  type ReadState,
} from "../src/client/read-executor";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
function fixture() {
  let generation = 0;
  const initial = generation;
  const states: ReadState[] = [];
  const reader = createReadExecutor({
    current: () => generation === initial,
    changed: (state) => states.push(state),
  });
  return {
    reader,
    states,
    changeOwner: () => {
      generation++;
    },
  };
}

it("lets the active read finish, coalesces bursts and settles all trailing callers", async () => {
  const { reader } = fixture();
  const pending = deferred<string>();
  const reads: string[] = [],
    received: string[] = [];
  let firstSignal!: AbortSignal;
  const first = reader.execute(
    (signal, mode) => {
      firstSignal = signal;
      reads.push(mode);
      return pending.promise;
    },
    (value) => {
      received.push(value);
    },
  );
  const skipped = reader.execute(
    async () => {
      reads.push("skipped");
      return "skipped";
    },
    (value) => {
      received.push(value);
    },
  );
  const latest = reader.execute(
    async () => {
      reads.push("latest");
      return "latest";
    },
    (value) => {
      received.push(value);
    },
  );
  expect(reads).toEqual(["automatic"]);
  expect(reader.isBusy()).toBe(true);
  pending.resolve("first");
  const completed = await first;
  const trailing = await Promise.all([skipped, latest]);
  expect(reads).toEqual(["automatic", "latest"]);
  expect(received).toEqual(["first", "latest"]);
  expect(trailing.map((value) => value.status)).toEqual(["success", "success"]);
  expect(firstSignal.aborted).toBe(true);
  expect(completed.status).toBe("success");
  if (completed.status !== "success")
    throw new Error("Expected completed snapshot");
  expect(completed.current()).toBe(true);
  reader.cancel();
  expect(completed.current()).toBe(false);
});

it("keeps the highest-priority trailing request while resolving lower-priority callers", async () => {
  const { reader } = fixture(),
    pending = deferred<string>();
  const received = vi.fn(),
    low = vi.fn(async () => "low");
  const first = reader.execute(() => pending.promise, received);
  const high = reader.execute(async () => "high", received, false, 2);
  const ignored = reader.execute(low, received, false, 1);
  pending.resolve("first");
  expect((await first).status).toBe("success");
  expect((await high).status).toBe("success");
  expect((await ignored).status).toBe("success");
  expect(low).not.toHaveBeenCalled();
  expect(received.mock.calls.map(([value]) => value)).toEqual([
    "first",
    "high",
  ]);
});

it("manual intent aborts the active read and cancels queued work without publishing its late result", async () => {
  const { reader } = fixture(),
    pending = deferred<string>();
  const received = vi.fn(),
    queuedRead = vi.fn(async () => "queued");
  let signal!: AbortSignal;
  const old = reader.execute((s) => {
    signal = s;
    return pending.promise;
  }, received);
  const queued = reader.execute(queuedRead, received);
  const modes: string[] = [];
  const manual = reader.execute(
    async (_signal, mode) => {
      modes.push(mode);
      return "manual";
    },
    received,
    true,
  );
  expect(signal.aborted).toBe(true);
  expect((await queued).status).toBe("cancelled");
  expect((await manual).status).toBe("success");
  pending.resolve("late");
  expect((await old).status).toBe("cancelled");
  expect(queuedRead).not.toHaveBeenCalled();
  expect(received.mock.calls.map(([value]) => value)).toEqual(["manual"]);
  expect(modes).toEqual(["manual"]);
});

it("retains a failed snapshot notice during recovery and clears it only on success or cancel", async () => {
  const { reader, states } = fixture(),
    error = new Error("Unavailable"),
    received = vi.fn();
  const failure = await reader.execute(async () => {
    throw error;
  }, received);
  expect(failure.status).toBe("error");
  expect(states.at(-1)).toEqual({
    error: "Unavailable",
    failure: error,
    busy: false,
  });
  const pending = deferred<string>();
  const next = reader.execute(() => pending.promise, received);
  expect(states.at(-1)).toEqual({
    error: "Unavailable",
    failure: error,
    busy: true,
  });
  pending.resolve("recovered");
  await next;
  expect(states.at(-1)).toEqual({ error: "", failure: undefined, busy: false });
  expect(
    await reader.load(async () => "void contract", received),
  ).toBeUndefined();
  reader.cancel();
  expect(states.at(-1)).toEqual({ error: "", failure: undefined, busy: false });
});

it("disposes pending and queued work, then supports effect reactivation without resurrecting the old read", async () => {
  const { reader, states } = fixture(),
    pending = deferred<string>(),
    received = vi.fn();
  const old = reader.execute(() => pending.promise, received);
  const queued = reader.execute(async () => "queued", received);
  reader.dispose();
  expect((await queued).status).toBe("cancelled");
  const inactive = vi.fn(async () => "inactive");
  expect((await reader.execute(inactive, received)).status).toBe("cancelled");
  expect(inactive).not.toHaveBeenCalled();
  reader.activate();
  await reader.load(async () => "reactivated", received);
  const before = states.length;
  pending.resolve("old");
  expect((await old).status).toBe("cancelled");
  expect(states).toHaveLength(before);
  expect(received.mock.calls.map(([value]) => value)).toEqual(["reactivated"]);
});

it("rejects old-generation publication and dispatch even when the owner returns to the same identity", async () => {
  const { reader, changeOwner } = fixture(),
    pending = deferred<string>(),
    received = vi.fn();
  const old = reader.execute(() => pending.promise, received);
  changeOwner();
  changeOwner();
  pending.resolve("obsolete");
  expect((await old).status).toBe("cancelled");
  reader.activate();
  const read = vi.fn(async () => "wrong generation");
  expect((await reader.execute(read, received)).status).toBe("cancelled");
  expect(read).not.toHaveBeenCalled();
  expect(received).not.toHaveBeenCalled();
});

it("does not dispatch when a state observer invalidates the owner before IO", async () => {
  let current = true;
  const reader = createReadExecutor({
    current: () => current,
    changed: (state) => {
      if (state.busy) current = false;
    },
  });
  const read = vi.fn(async () => "must not dispatch");
  expect((await reader.execute(read, vi.fn())).status).toBe("cancelled");
  expect(read).not.toHaveBeenCalled();
});

it("does not clear a newer read's busy state when receive starts another intent", async () => {
  const { reader, states } = fixture(),
    pending = deferred<string>();
  let next: Promise<void> | undefined;
  await reader.execute(
    async () => "first",
    () => {
      next = reader.load(
        () => pending.promise,
        () => {},
        true,
      );
    },
  );
  expect(reader.isBusy()).toBe(true);
  expect(states.at(-1)?.busy).toBe(true);
  pending.resolve("second");
  await next;
  expect(reader.isBusy()).toBe(false);
  expect(states.at(-1)?.busy).toBe(false);
});
