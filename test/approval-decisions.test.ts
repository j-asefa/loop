import { afterAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const directory = mkdtempSync(join(tmpdir(), "loop-approval-decisions-"));
vi.stubEnv("LOOP_DATA_DIR", directory);
vi.stubEnv("LOOP_ENCRYPTION_KEY", randomBytes(32).toString("hex"));
const { db, id, changes, deadlines } = await import("../src/server/db");
const { enqueue } = await import("../src/server/queue");
const { approve, decide, requestApproval } =
  await import("../src/server/approvals");
afterAll(() => {
  deadlines.close();
  changes.close();
  db.close();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});
function fixture(state: string) {
  const owner = id();
  const run = enqueue(owner, "Approval fixture", id());
  db.prepare("UPDATE runs SET state=? WHERE id=?").run(state, run.id);
  const approval = requestApproval(run, { tool: "fixture" });
  return { owner, run, approval };
}
function result(run: string, approval: string) {
  return {
    run: db.prepare("SELECT state FROM runs WHERE id=?").get(run),
    approval: db
      .prepare("SELECT state FROM approvals WHERE id=?")
      .get(approval),
    automatic: db
      .prepare(
        "SELECT payload FROM events WHERE run_id=? AND type='approval.auto_approved'",
      )
      .all(run),
    history: db
      .prepare("SELECT id FROM personal_decisions WHERE run_id=?")
      .all(run),
  };
}
it.each(["running", "pausing"])(
  "policy approval keeps an inline %s run in place and emits once",
  (state) => {
    const f = fixture(state);
    expect(
      approve(f.owner, f.approval.id, { by: "policy", execution: "inline" }),
    ).toEqual({ ok: true });
    expect(result(f.run.id, f.approval.id)).toEqual({
      run: { state },
      approval: { state: "approved" },
      automatic: [{ payload: JSON.stringify({ approvalId: f.approval.id }) }],
      history: [],
    });
    expect(
      approve(f.owner, f.approval.id, { by: "policy", execution: "inline" }),
    ).toEqual({ ok: false });
    expect(result(f.run.id, f.approval.id).automatic).toHaveLength(1);
  },
);
it("policy approval resumes a waiting run without personal history", () => {
  const f = fixture("awaiting_approval");
  expect(approve(f.owner, f.approval.id, { by: "policy" })).toEqual({
    ok: true,
  });
  expect(result(f.run.id, f.approval.id)).toEqual({
    run: { state: "queued" },
    approval: { state: "approved" },
    automatic: [{ payload: JSON.stringify({ approvalId: f.approval.id }) }],
    history: [],
  });
});
it("does not change expired inline approvals or accept another owner's decision", () => {
  const f = fixture("running");
  expect(() =>
    approve(id(), f.approval.id, { by: "policy", execution: "inline" }),
  ).toThrow("Item not found");
  db.prepare("UPDATE approvals SET expires_at=0 WHERE id=?").run(f.approval.id);
  expect(
    approve(f.owner, f.approval.id, { by: "policy", execution: "inline" }),
  ).toEqual({ ok: false });
  expect(result(f.run.id, f.approval.id)).toEqual({
    run: { state: "running" },
    approval: { state: "pending" },
    automatic: [],
    history: [],
  });
});
it("user decisions still require a waiting run and reject expired approvals", () => {
  const f = fixture("running");
  expect(() => decide(f.owner, f.approval.id, "approve")).toThrow(
    "no longer pending",
  );
  db.prepare("UPDATE runs SET state='awaiting_approval' WHERE id=?").run(
    f.run.id,
  );
  db.prepare("UPDATE approvals SET expires_at=0 WHERE id=?").run(f.approval.id);
  expect(() => decide(f.owner, f.approval.id, "approve")).toThrow("expired");
  expect(result(f.run.id, f.approval.id).approval).toEqual({
    state: "pending",
  });
});
