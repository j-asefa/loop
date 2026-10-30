import { settleStoredSend } from "../src/client/sendIntent";
import { expect, it } from "vitest";
import {
  omitsReplyTarget,
  planSend,
  settleFailure,
} from "../src/client/sendIntent";

const keys = () => {
  let n = 0;
  return () => "key-" + ++n;
};

it("starts a fresh fleet send only after a proven refusal, preserving uncertain choices", () => {
  const newKey = keys(),
    intent = { mode: "send" as const, sendAt: null };
  const first = planSend({ signature: "", key: "" }, "message", intent, newKey);
  const refused = settleFailure(first.receipt, 503, "refused");
  expect(planSend(refused, "message", intent, newKey).receipt.key).not.toBe(
    first.receipt.key,
  );
  for (const outcome of ["unknown", "completed"])
    expect(settleFailure(first.receipt, 409, outcome)).toBe(first.receipt);
});

it("repeats an uncertain send exactly as first requested", () => {
  const newKey = keys();
  const first = planSend(
    { signature: "", key: "" },
    "message",
    { mode: "schedule", sendAt: 1000 },
    newKey,
  );
  expect(first).toMatchObject({
    receipt: { key: "key-1", pending: true },
    intent: { mode: "schedule", sendAt: 1000 },
    reconciled: false,
  });
  // The response was lost; a relative time picked again is a new timestamp.
  const uncertain = settleFailure(first.receipt, undefined);
  const retry = planSend(
    uncertain,
    "message",
    { mode: "schedule", sendAt: 1060 },
    newKey,
  );
  expect(retry).toMatchObject({
    receipt: { key: "key-1" },
    intent: { mode: "schedule", sendAt: 1000 },
    reconciled: true,
  });
  // Choosing to send now instead also repeats the uncertain request first.
  expect(
    planSend(uncertain, "message", { mode: "send", sendAt: null }, newKey)
      .intent,
  ).toEqual({ mode: "schedule", sendAt: 1000 });
  // A server error is still uncertain.
  expect(settleFailure(first.receipt, 503).pending).toBe(true);
});

it("lets a refused send change its choice, and a new message get a new key", () => {
  const newKey = keys();
  const first = planSend(
    { signature: "", key: "" },
    "message",
    { mode: "schedule", sendAt: 1000 },
    newKey,
  );
  const refused = settleFailure(first.receipt, 400);
  expect(refused.pending).toBe(false);
  const changed = planSend(
    refused,
    "message",
    { mode: "send", sendAt: null },
    newKey,
  );
  expect(changed).toMatchObject({
    receipt: { key: "key-1", pending: true },
    intent: { mode: "send", sendAt: null },
    reconciled: false,
  });
  expect(
    planSend(
      changed.receipt,
      "edited message",
      { mode: "send", sendAt: null },
      newKey,
    ).receipt.key,
  ).toBe("key-2");
});

it("does not let a late response erase or replace a newer pending send", () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };
  const newer = { signature: "new message", key: "new-key", pending: true };
  storage.setItem("thread", JSON.stringify(newer));
  settleStoredSend(storage, "thread", "old-key", null);
  settleStoredSend(storage, "thread", "old-key", {
    signature: "old message",
    key: "old-key",
    pending: true,
  });
  expect(JSON.parse(storage.getItem("thread")!)).toEqual(newer);
  settleStoredSend(storage, "thread", "new-key", null);
  // A failed concurrent retry cannot resurrect an already acknowledged send.
  settleStoredSend(storage, "thread", "new-key", newer);
  expect(storage.getItem("thread")).toBeNull();
});

it("leaves out a reply target as the composer showed, and repeats that on retry", () => {
  const newKey = keys();
  const empty = { signature: "", key: "" };
  const now = { mode: "send" as const, sendAt: null };
  const first = planSend(empty, "reply", now, newKey);
  expect(omitsReplyTarget(empty, first, true)).toBe(true);
  expect(omitsReplyTarget(empty, first, false)).toBe(false);
  // The decision does not depend on the send option: the composer showed it.
  expect(
    omitsReplyTarget(
      empty,
      planSend(empty, "reply", { mode: "schedule", sendAt: 5 }, newKey),
      true,
    ),
  ).toBe(true);
  // An uncertain send is repeated as first sent, whatever is latest now.
  const sent = settleFailure({ ...first.receipt, unquoted: true }, undefined);
  expect(
    omitsReplyTarget(sent, planSend(sent, "reply", now, newKey), false),
  ).toBe(true);
  const quoted = settleFailure(
    { ...first.receipt, unquoted: false },
    undefined,
  );
  expect(
    omitsReplyTarget(quoted, planSend(quoted, "reply", now, newKey), true),
  ).toBe(false);
  // A receipt from before this decision existed always sent its target.
  const legacy = settleFailure(first.receipt, undefined);
  expect(
    omitsReplyTarget(legacy, planSend(legacy, "reply", now, newKey), true),
  ).toBe(false);
});
