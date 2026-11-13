import { expect, it } from "vitest";
import { Approval } from "../src/shared/approval-contract-schema.js";
import { ApprovalState } from "../src/shared/approvals.js";

const base = {
  id: "approval",
  owner_id: "owner",
  run_id: "run",
  digest: "digest",
  request: "opaque request text",
  created_at: 1,
  expires_at: 2,
  conversation_id: null,
  input: "input",
  name: null,
  provider: null,
};
it("covers the lifecycle vocabulary and retains expiry in every state", () => {
  expect(Approval.options.map((arm) => arm.shape.state.value)).toEqual(
    ApprovalState.options,
  );
  for (const state of ApprovalState.options) {
    const result =
      state === "completed" || state === "unknown"
        ? "opaque result text"
        : null;
    const approval = Approval.parse({ ...base, state, result });
    if (approval.state === "completed" || approval.state === "unknown") {
      // Typecheck also verifies that state narrowing makes result non-null.
      expect(approval.result.toUpperCase()).toBe("OPAQUE RESULT TEXT");
    }
    expect(approval).toEqual({
      ...base,
      state,
      result,
    });
  }
});
it("requires null results before execution finishes", () => {
  for (const state of ["pending", "approved", "executing"]) {
    expect(
      Approval.safeParse({ ...base, state, result: "unexpected" }).success,
    ).toBe(false);
    expect(Approval.safeParse({ ...base, state }).success).toBe(false);
  }
});
it("requires stored result text for completed and uncertain outcomes", () => {
  for (const state of ["completed", "unknown"]) {
    expect(Approval.safeParse({ ...base, state, result: null }).success).toBe(
      false,
    );
    expect(Approval.safeParse({ ...base, state }).success).toBe(false);
    expect(Approval.safeParse({ ...base, state, result: "" }).success).toBe(
      true,
    );
  }
});
it("allows both ordinary and simulated rejection results", () => {
  for (const result of [
    null,
    "Simulated decision; nothing was sent externally.",
  ]) {
    expect(Approval.parse({ ...base, state: "rejected", result }).result).toBe(
      result,
    );
  }
});
