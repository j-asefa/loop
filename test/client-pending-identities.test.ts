import { expect, it, beforeAll, afterAll, vi } from "vitest";
import {
  planSend,
  settleFailure,
  type SendReceipt,
} from "../src/client/sendIntent";
import {
  beginUpgradeStart,
  clearRunRetryKey,
  clearUpgradeCommandId,
  confirmUpgradeStart,
  runRetryKey,
  upgradeCommandId,
} from "../src/client/durableIdentities";
import {
  prepareStoredSend,
  readSendReceipt,
  sendReceiptKey,
  settleStoredSend,
  storeSendReceipt,
} from "../src/client/sendReceiptStore";

/** Minimal durable and session-backed Storage for the tests. */
class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear() {
    this.store.clear();
  }
  getItem(key: string) {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  key(index: number) {
    return [...this.store.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  setItem(key: string, value: string) {
    this.store.set(key, value);
  }
}

// A FIFO lock fixture; the browser smoke uses the actual cross-tab Web Locks API.
beforeAll(() => {
  const tails = new Map<string, Promise<unknown>>();
  vi.stubGlobal("navigator", {
    locks: {
      request: (key: string, callback: () => unknown) => {
        const next = (tails.get(key) ?? Promise.resolve()).then(callback);
        tails.set(
          key,
          next.catch(() => {}),
        );
        return next;
      },
    },
  });
});
afterAll(() => vi.unstubAllGlobals());

const keys = () => {
  let n = 0;
  return () => "key-" + ++n;
};

it("a pending composer receipt survives a session wipe and reload, reusing its key", async () => {
  // localStorage (durable) survives auth expiry and a new tab; sessionStorage
  // is per-tab and Session clears it on expiry. The receipt must live in the
  // durable store, or a re-send would mint a new key and run the accepted
  // request twice.
  const durable = new MemoryStorage();
  const session = new MemoryStorage();
  const key = sendReceiptKey("alice", "laptop", "conv-1");
  const receipt = planSend(
    { signature: "", key: "" },
    "hello",
    { mode: "send", sendAt: null },
    keys(),
  ).receipt;
  storeSendReceipt(durable, key, receipt);

  // The old path stored the receipt only in sessionStorage.
  storeSendReceipt(session, key, receipt);
  session.clear(); // Session.expire -> sessionStorage.clear();

  const recovered = readSendReceipt(durable, key);
  // After the wipe the old session-backed receipt is gone.
  expect(readSendReceipt(session, key)).toEqual({ signature: "", key: "" });
  // The durable receipt is still there and replays with the same key.
  const retry = planSend(
    recovered,
    "hello",
    { mode: "send", sendAt: null },
    keys(),
  );
  expect(recovered.key).toBe(receipt.key);
  expect(retry.receipt.key).toBe(receipt.key);
  // Settlement removes it for the next message.
  await settleStoredSend(durable, key, receipt, null);
  expect(readSendReceipt(durable, key)).toEqual({ signature: "", key: "" });
});

it("a pending receipt is owner/thread scoped", () => {
  const durable = new MemoryStorage();
  const a = new MemoryStorage();
  const receipt: SendReceipt = {
    signature: "m",
    key: "k",
    pending: true,
    intent: { mode: "send", sendAt: null },
  };
  storeSendReceipt(
    durable,
    sendReceiptKey("alice", "laptop", "conv-1"),
    receipt,
  );
  // Same owner, different thread.
  expect(
    readSendReceipt(durable, sendReceiptKey("alice", "laptop", "conv-2")),
  ).toEqual({ signature: "", key: "" });
  // A different account never reads another's pending send.
  expect(
    readSendReceipt(durable, sendReceiptKey("bob", "laptop", "conv-1")),
  ).toEqual({ signature: "", key: "" });
});

it("a run retry key is stable across reloads and cleared on settlement", () => {
  const durable = new MemoryStorage();
  const first = runRetryKey(durable, "alice", "laptop", "run-1");
  // Reload: the same key is reused so an accepted retry is not rerun.
  expect(runRetryKey(durable, "alice", "laptop", "run-1")).toBe(first);
  // A different run and a different owner get distinct keys.
  expect(runRetryKey(durable, "alice", "laptop", "run-2")).not.toBe(first);
  expect(runRetryKey(durable, "bob", "laptop", "run-1")).not.toBe(first);
  // Settlement (refused or accepted) clears it for a real fresh retry.
  clearRunRetryKey(durable, "alice", "laptop", "run-1");
  expect(runRetryKey(durable, "alice", "laptop", "run-1")).not.toBe(first);
});

it("a harness upgrade reuses its command id until the upgrade settles", () => {
  const durable = new MemoryStorage();
  const first = upgradeCommandId(durable, "laptop", "host");
  // A lost start response retries with the same command id, so the host's
  // command-id dedupe matches and the installer is not rerun.
  expect(upgradeCommandId(durable, "laptop", "host")).toBe(first);
  // Once settled, a later start gets a fresh id.
  clearUpgradeCommandId(durable, "laptop", "host", first);
  expect(upgradeCommandId(durable, "laptop", "host")).not.toBe(first);
});

it("keeps an upgrade command id only across an uncertain start", () => {
  const durable = new MemoryStorage();
  // An uncertain start (lost reply) keeps the id for the retry.
  const pending = beginUpgradeStart(durable, "laptop", "host");
  expect(beginUpgradeStart(durable, "laptop", "host")).toBe(pending);
  // The host confirms the start: the id is consumed, so a later genuine
  // upgrade mints a fresh id instead of deduping onto a settled record (which
  // would run no installer).
  confirmUpgradeStart(durable, "laptop", "host", pending);
  expect(beginUpgradeStart(durable, "laptop", "host")).not.toBe(pending);
});

it("a late answer for an earlier upgrade start keeps a newer start's pending id", () => {
  const durable = new MemoryStorage();
  // Tab A starts with id A; its reply is slow.
  const a = beginUpgradeStart(durable, "laptop", "host");
  confirmUpgradeStart(durable, "laptop", "host", a);
  // The upgrade settles and tab B starts with id B; B's reply is lost.
  const b = beginUpgradeStart(durable, "laptop", "host");
  // A's delayed acknowledgement, or a status refresh showing A's settled
  // record, arrives now. Neither may drop B's pending id.
  confirmUpgradeStart(durable, "laptop", "host", a);
  clearUpgradeCommandId(durable, "laptop", "host", a);
  expect(beginUpgradeStart(durable, "laptop", "host")).toBe(b);
});

it("another message in the thread, from any tab, keeps an uncertain receipt", async () => {
  // Tabs share durable storage. Tab A's send of "first" is uncertain; tab B
  // then sends and settles "second" in the same thread. Tab A's receipt must
  // survive, or a restored "first" would go out with a fresh key.
  const durable = new MemoryStorage();
  const key = sendReceiptKey("alice", "", "conv-1");
  const now = { mode: "send" as const, sendAt: null };
  const first = planSend(
    { signature: "", key: "" },
    "first",
    now,
    keys(),
  ).receipt;
  storeSendReceipt(durable, key, first);
  const second = planSend(
    readSendReceipt(durable, key, "second"),
    "second",
    now,
    () => "other-key",
  ).receipt;
  storeSendReceipt(durable, key, second);
  await settleStoredSend(durable, key, second, null);
  // Tab A (or the app after a restart) finds its own message's receipt.
  const stored = readSendReceipt(durable, key, "first");
  expect(stored).toEqual(first);
  expect(planSend(stored, "first", now, keys()).receipt.key).toBe(first.key);
  // A late reply for the settled send changes nothing.
  await settleStoredSend(durable, key, second, second);
  expect(readSendReceipt(durable, key, "second")).toEqual({
    signature: "",
    key: "",
  });
});

it("keeps every pending receipt when the per-thread list is full", () => {
  const durable = new MemoryStorage();
  const key = sendReceiptKey("alice", "", "conv-1");
  const pending = (n: number): SendReceipt => ({
    signature: "pending-" + n,
    key: "p" + n,
    pending: true,
  });
  storeSendReceipt(durable, key, pending(0));
  for (let n = 0; n < 25; n++)
    storeSendReceipt(durable, key, {
      signature: "refused-" + n,
      key: "r" + n,
      pending: false,
    });
  expect(readSendReceipt(durable, key, "pending-0")).toEqual(pending(0));
});

it("retains more than twenty uncertain sends and reuses the oldest key", () => {
  const storage = new MemoryStorage();
  const scope = sendReceiptKey("alice", "", "overflow");
  for (let n = 0; n < 25; n++)
    storeSendReceipt(storage, scope, {
      signature: "pending-" + n,
      key: "key-" + n,
      pending: true,
      intent: { mode: "send", sendAt: null },
    });
  const original = readSendReceipt(storage, scope, "pending-0");
  expect(
    planSend(
      original,
      "pending-0",
      { mode: "send", sendAt: null },
      () => "duplicate",
    ).receipt.key,
  ).toBe("key-0");
});

it("remembers a retry key on the local workspace, whose source ID is empty", () => {
  const durable = new MemoryStorage();
  const first = runRetryKey(durable, "alice", "", "run-1");
  // A reload re-reads the same key instead of minting a new one.
  expect(runRetryKey(durable, "alice", "", "run-1")).toBe(first);
  clearRunRetryKey(durable, "alice", "", "run-1");
  expect(runRetryKey(durable, "alice", "", "run-1")).not.toBe(first);
  // Signed out: nothing is stored.
  const before = durable.length;
  runRetryKey(durable, undefined, "", "run-2");
  expect(durable.length).toBe(before);
});

it("serializes concurrent preparation and settlement without losing another send", async () => {
  const storage = new MemoryStorage();
  const scope = sendReceiptKey("alice", "", "parallel");
  const intent = { mode: "send" as const, sendAt: null };
  const empty = { signature: "", key: "" };
  const [a, b, duplicate] = await Promise.all([
    prepareStoredSend(storage, scope, "a", empty, intent, false),
    prepareStoredSend(storage, scope, "b", empty, intent, false),
    prepareStoredSend(storage, scope, "a", empty, intent, false),
  ]);
  expect(duplicate!.receipt.key).toBe(a!.receipt.key);
  await Promise.all([
    settleStoredSend(storage, scope, b!.receipt, null),
    prepareStoredSend(storage, scope, "c", empty, intent, false),
  ]);
  expect(readSendReceipt(storage, scope, "a").key).toBe(a!.receipt.key);
  expect(readSendReceipt(storage, scope, "c").key).not.toBe("");
});

it("refuses preparation when persistence fails, retaining the earlier identity", async () => {
  const storage = new MemoryStorage();
  const scope = sendReceiptKey("alice", "", "quota");
  const empty = { signature: "", key: "" };
  const intent = { mode: "send" as const, sendAt: null };
  const a = await prepareStoredSend(storage, scope, "a", empty, intent, false);
  vi.spyOn(storage, "setItem").mockImplementation(() => {
    throw new Error("QuotaExceededError");
  });
  await expect(
    prepareStoredSend(storage, scope, "b", empty, intent, false),
  ).rejects.toThrow("nothing was sent");
  expect(readSendReceipt(storage, scope, "a").key).toBe(a!.receipt.key);
  await expect(
    settleStoredSend(storage, scope, a!.receipt, {
      ...a!.receipt,
      pending: false,
    }),
  ).resolves.toBeUndefined();
  expect(readSendReceipt(storage, scope, "a").pending).toBe(true);
});

it("storage read failure leaves the composer renderable but refuses sending", async () => {
  const storage = new MemoryStorage();
  vi.spyOn(storage, "getItem").mockImplementation(() => {
    throw new Error("SecurityError");
  });
  expect(readSendReceipt(storage, "scope")).toEqual({ signature: "", key: "" });
  await expect(
    prepareStoredSend(
      storage,
      "scope",
      "message",
      { signature: "", key: "" },
      { mode: "send", sendAt: null },
      false,
    ),
  ).rejects.toThrow("Cannot read pending sends");
});

it("abandons a choice changed while waiting without persisting its schedule", async () => {
  const storage = new MemoryStorage();
  const scope = sendReceiptKey("alice", "", "abandoned");
  const empty = { signature: "", key: "" };
  let current = true;
  const waiting = prepareStoredSend(
    storage,
    scope,
    "message",
    empty,
    { mode: "schedule", sendAt: 1000 },
    false,
    () => current,
  );
  current = false;
  expect(await waiting).toBeNull();
  expect(readSendReceipt(storage, scope, "message").key).toBe("");
  const next = await prepareStoredSend(
    storage,
    scope,
    "message",
    empty,
    { mode: "send", sendAt: null },
    false,
  );
  expect(next?.intent).toEqual({ mode: "send", sendAt: null });
});

it.each([false, true])(
  "ignores a late refusal after a same-key retry (changed intent: %s)",
  async (changed) => {
    const storage = new MemoryStorage();
    const scope = sendReceiptKey("alice", "", "attempts");
    const empty = { signature: "", key: "" };
    const initial = { mode: "send" as const, sendAt: null };
    const a = (await prepareStoredSend(
      storage,
      scope,
      "message",
      empty,
      initial,
      false,
    ))!;
    const b = (await prepareStoredSend(
      storage,
      scope,
      "message",
      empty,
      initial,
      false,
    ))!;
    await settleStoredSend(
      storage,
      scope,
      a.receipt,
      settleFailure(a.receipt, 409),
    );
    const requested = changed
      ? { mode: "schedule" as const, sendAt: 1000 }
      : initial;
    const retry = (await prepareStoredSend(
      storage,
      scope,
      "message",
      empty,
      requested,
      false,
    ))!;
    expect(retry.receipt.key).toBe(a.receipt.key);
    expect(retry.receipt.attempt).not.toBe(a.receipt.attempt);
    await settleStoredSend(
      storage,
      scope,
      b.receipt,
      settleFailure(b.receipt, 409),
    );
    await settleStoredSend(storage, scope, b.receipt, null);
    expect(readSendReceipt(storage, scope, "message")).toEqual(retry.receipt);
    const afterReload = (await prepareStoredSend(
      storage,
      scope,
      "message",
      empty,
      initial,
      false,
    ))!;
    expect(afterReload.receipt).toEqual(retry.receipt);
    expect(afterReload.intent).toEqual(requested);
  },
);

it("starts dispatch before a post-lock view change and releases the lock before settlement", async () => {
  const storage = new MemoryStorage();
  const scope = sendReceiptKey("alice", "", "dispatch-gap");
  let current = true;
  const starts: boolean[] = [];
  let finish!: () => void;
  const network = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const first = await prepareStoredSend(
    storage,
    scope,
    "message",
    { signature: "", key: "" },
    { mode: "schedule", sendAt: 1000 },
    false,
    () => current,
    async (plan) => {
      expect(readSendReceipt(storage, scope, "message")).toEqual(plan.receipt);
      starts.push(current);
      queueMicrotask(() => {
        current = false;
      });
      await network;
      await settleStoredSend(storage, scope, plan.receipt, null);
    },
  );
  expect(current).toBe(false);
  expect(starts).toEqual([true]);
  // A different message can prepare while the first network call is pending.
  const second = await prepareStoredSend(
    storage,
    scope,
    "other",
    { signature: "", key: "" },
    { mode: "send", sendAt: null },
    false,
  );
  expect(second?.receipt.signature).toBe("other");
  finish();
  await first?.completion;
  expect(readSendReceipt(storage, scope, "message").key).toBe("");
});
