import { expect, it } from "vitest";
import {
  planSend,
  settleStoredSend,
  type SendReceipt,
} from "../src/client/sendIntent";
import {
  clearRunRetryKey,
  clearUpgradeCommandId,
  runRetryKey,
  upgradeCommandId,
} from "../src/client/durableIdentities";
import {
  readSendReceipt,
  sendReceiptKey,
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

const keys = () => {
  let n = 0;
  return () => "key-" + ++n;
};

it("a pending composer receipt survives a session wipe and reload, reusing its key", () => {
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
  durable.setItem(key, JSON.stringify(receipt));

  // The old path stored the receipt only in sessionStorage.
  session.setItem(key, JSON.stringify(receipt));
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
  settleStoredSend(durable, key, receipt.key, null);
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
  durable.setItem(
    sendReceiptKey("alice", "laptop", "conv-1"),
    JSON.stringify(receipt),
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
  clearUpgradeCommandId(durable, "laptop", "host");
  expect(upgradeCommandId(durable, "laptop", "host")).not.toBe(first);
});
