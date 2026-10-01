import { expect, it } from "vitest";
import { planSend, settleFailure } from "../src/client/sendIntent";

const keys = () => {
  let n = 0;
  return () => "key-" + ++n;
};

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
  const retry = planSend(uncertain, "message", { mode: "schedule", sendAt: 1060 }, newKey);
  expect(retry).toMatchObject({
    receipt: { key: "key-1" },
    intent: { mode: "schedule", sendAt: 1000 },
    reconciled: true,
  });
  // Choosing to send now instead also repeats the uncertain request first.
  expect(
    planSend(uncertain, "message", { mode: "send", sendAt: null }, newKey).intent,
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
  const changed = planSend(refused, "message", { mode: "send", sendAt: null }, newKey);
  expect(changed).toMatchObject({
    receipt: { key: "key-1", pending: true },
    intent: { mode: "send", sendAt: null },
    reconciled: false,
  });
  expect(
    planSend(changed.receipt, "edited message", { mode: "send", sendAt: null }, newKey)
      .receipt.key,
  ).toBe("key-2");
});
