import type { WorkspaceEmission } from "../src/shared/workspace-events";
import { afterAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "loop-transition-hooks-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const database = await import("../src/server/db");
const { db, id } = database;
const { checkoutTransitions } = await import("../src/server/run-checkouts");
const webhooks = await import("../src/server/webhook-outbox");
const observed: string[] = [];
let target = "",
  failWebhook = false,
  outerTransaction = false;
const pending = () =>
  db
    .prepare("SELECT capture_pending FROM run_checkouts WHERE run_id=?")
    .get(target);
const completed = () =>
  db
    .prepare("SELECT id FROM events WHERE run_id=? AND type='completed'")
    .all(target);
const deliveries = () =>
  db
    .prepare(
      "SELECT d.id FROM webhook_deliveries d JOIN events e ON e.id=d.event_id WHERE e.run_id=?",
    )
    .all(target);
const before = checkoutTransitions.beforeEvent;
vi.spyOn(checkoutTransitions, "beforeEvent").mockImplementation(
  (run, state) => {
    before(run, state);
    if (run.id !== target || state !== "completed") return;
    expect(db.inTransaction).toBe(true);
    expect(pending()).toEqual({ capture_pending: 1 });
    expect(completed()).toEqual([]);
    observed.push("capture requested");
  },
);
const emit = database.emit;
vi.spyOn(database, "emit").mockImplementation(
  (
    owner: string,
    input: Parameters<typeof emit>[1],
    ...event: WorkspaceEmission
  ) => {
    if (input === target && event[0] === "completed") {
      expect(pending()).toEqual({ capture_pending: 1 });
      observed.push("event");
    }
    return emit(owner, input, ...event);
  },
);
const enqueueWebhooks = webhooks.enqueueStoppedWebhooks;
vi.spyOn(webhooks, "enqueueStoppedWebhooks").mockImplementation(
  (connection, event) => {
    const row = connection
      .prepare("SELECT run_id,type FROM events WHERE id=?")
      .get(event) as { run_id: string; type: string };
    if (row.run_id === target && row.type === "completed") {
      expect(connection.inTransaction).toBe(true);
      expect(completed()).toHaveLength(1);
      observed.push("webhooks");
    }
    enqueueWebhooks(connection, event);
    if (row.run_id === target && row.type === "completed" && failWebhook)
      throw new Error("Fixture outbox failure");
  },
);
const capture = checkoutTransitions.afterTransition;
vi.spyOn(checkoutTransitions, "afterTransition").mockImplementation(
  (run, state) => {
    if (run.id === target && state === "completed") {
      expect(db.inTransaction).toBe(outerTransaction);
      expect(deliveries()).toHaveLength(1);
      observed.push("capture started");
    }
    capture(run, state);
  },
);
const { enqueue, claim, transition, completeLeased } =
  await import("../src/server/queue");
afterAll(() => {
  vi.restoreAllMocks();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  target = "";
  failWebhook = false;
  outerTransaction = false;
  observed.length = 0;
  const owner = id();
  const run = enqueue(owner, "Finish", id());
  expect(claim("fixture", (candidate) => candidate.id === run.id)?.id).toBe(
    run.id,
  );
  target = run.id;
  db.prepare(
    "INSERT INTO run_checkouts(id,owner_id,run_id,agent_id,conversation_id,directory,source,branch,start_head,start_dirty,start_untracked,started_at,state) VALUES(?,?,?,'agent','conversation','','','','',0,0,0,'failed')",
  ).run(id(), owner, run.id);
  db.prepare(
    "INSERT INTO webhook_subscriptions(id,owner_id,url,secret_sealed,creation_digest,kinds,local,state,created_at) VALUES(?,?,'https://example.com','','','[\"run.stopped\"]',0,'active',0)",
  ).run(id(), owner);
  return run;
}
it.each([false, true])(
  "preserves completed-run effect order with outer transaction=%s",
  (outer) => {
    const run = fixture();
    outerTransaction = outer;
    expect(
      outer ? completeLeased(run, "fixture") : transition(run, "completed"),
    ).toBe(true);
    expect(observed).toEqual([
      "capture requested",
      "event",
      "webhooks",
      "capture started",
    ]);
    expect(pending()).toEqual({ capture_pending: 0 });
    expect(completed()).toHaveLength(1);
    expect(deliveries()).toHaveLength(1);
    expect(transition(run, "completed")).toBe(false);
    expect(observed).toHaveLength(4);
  },
);
it("rolls back all durable effects if outbox enqueue fails and does not start capture", () => {
  const run = fixture();
  failWebhook = true;
  expect(() => transition(run, "completed")).toThrow("Fixture outbox failure");
  expect(observed).toEqual(["capture requested", "event", "webhooks"]);
  expect(db.prepare("SELECT state FROM runs WHERE id=?").get(run.id)).toEqual({
    state: "running",
  });
  expect(pending()).toEqual({ capture_pending: 0 });
  expect(completed()).toEqual([]);
  expect(deliveries()).toEqual([]);
  observed.length = 0;
  failWebhook = false;
  expect(transition({ ...run, owner_id: id() }, "completed")).toBe(false);
  expect(observed).toEqual([]);
  expect(transition(run, "completed")).toBe(true);
  expect(deliveries()).toHaveLength(1);
});
