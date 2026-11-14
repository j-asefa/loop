import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { applyMigrations } from "../src/server/migrations";
import { createChangeBus } from "../src/server/changes";
import {
  changeClock,
  createDeadlineScheduler,
} from "../src/server/change-deadlines";

function fixture() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  applyMigrations(db, "migrations");
  const insert =
    db.prepare(`INSERT INTO webhook_subscriptions(id,owner_id,url,secret_sealed,creation_digest,kinds,local,state,created_at)
    VALUES(?,?,'https://receiver.invalid','never-publish-secret','digest','["run.stopped"]',0,'pending_activation',1)`);
  insert.run("one", "owner");
  insert.run("two", "other");
  const events = (owner = "owner") =>
    db
      .prepare(
        "SELECT * FROM events WHERE owner_id=? AND json_extract(payload,'$.scope.id')='webhooks' ORDER BY id",
      )
      .all(owner);
  return { db, events };
}

it("commits owner-scoped webhook view notifications with subscription changes and rolls them back together", () => {
  const { db, events } = fixture();
  try {
    expect(events().length).toBeGreaterThan(0);
    const other = events("other");
    for (const sql of [
      "UPDATE webhook_subscriptions SET state='active' WHERE id='one'",
      "UPDATE webhook_subscriptions SET kinds='[]' WHERE id='one'",
      "UPDATE webhook_subscriptions SET state='failed',last_error='Unreachable',last_attempts=6 WHERE id='one'",
      "UPDATE webhook_subscriptions SET state='revoked',revoked_at=2 WHERE id='one'",
    ]) {
      const before = events().length;
      db.exec(sql);
      expect(events().length).toBeGreaterThan(before);
      expect(events("other")).toEqual(other);
    }
    const before = events();
    expect(() =>
      db
        .transaction(() => {
          db.exec(
            "UPDATE webhook_subscriptions SET state='active' WHERE id='one'",
          );
          throw new Error("rollback");
        })
        .immediate(),
    ).toThrow("rollback");
    expect(events()).toEqual(before);
    db.exec("UPDATE webhook_subscriptions SET state=state WHERE id='one'");
    expect(events()).toEqual(before);
    expect(JSON.stringify(events())).not.toContain("never-publish-secret");
  } finally {
    db.close();
  }
});

it("notifies queue, lease, dispatch, release, outcome and removal without exposing delivery payloads", () => {
  const { db, events } = fixture();
  try {
    const other = events("other");
    for (const sql of [
      "INSERT INTO webhook_deliveries(id,subscription_id,kind,purpose,payload,created_at,available_at) VALUES('job','one','control','activation','never-publish-payload',1,1)",
      "UPDATE webhook_deliveries SET leased_until=100,lease_id='lease' WHERE id='job'",
      "UPDATE webhook_deliveries SET attempts=1,dispatch_started_at=2,outcome='sending' WHERE id='job'",
      "UPDATE webhook_deliveries SET leased_until=NULL,lease_id=NULL WHERE id='job'",
      "UPDATE webhook_deliveries SET leased_until=200,lease_id='next' WHERE id='job'",
      "UPDATE webhook_deliveries SET delivered_at=3,leased_until=NULL,lease_id=NULL,last_status=204,outcome='accepted' WHERE id='job'",
      "DELETE FROM webhook_deliveries WHERE id='job'",
    ]) {
      const before = events().length;
      db.exec(sql);
      expect(events().length).toBeGreaterThan(before);
      expect(events("other")).toEqual(other);
    }
    expect(JSON.stringify(events())).not.toContain("never-publish-payload");
  } finally {
    db.close();
  }
});

it("recovers an overdue webhook lease notification after scheduler restart without dispatching a delivery", async () => {
  const { db, events } = fixture();
  const bus = createChangeBus(db, { pollMs: 10 });
  let scheduler: ReturnType<typeof createDeadlineScheduler> | undefined;
  const emit: typeof import("../src/server/db").emit = (
    owner,
    subject,
    type,
    payload,
  ) => {
    const id = Number(
      db
        .prepare(
          "INSERT INTO events(owner_id,subject_kind,subject_id,type,payload,created_at) VALUES(?,'collection',?,?,?,?)",
        )
        .run(
          owner,
          typeof subject === "string" ? subject : subject.id,
          type,
          JSON.stringify(payload),
          Date.now(),
        ).lastInsertRowid,
    );
    bus.wake();
    return id;
  };
  try {
    const expires = Date.now() + 100;
    db.prepare(
      "INSERT INTO webhook_deliveries(id,subscription_id,kind,purpose,payload,created_at,available_at,leased_until,lease_id) VALUES('job','one','control','activation','{}',1,1,?,'lease')",
    ).run(expires);
    expect(changeClock(db, "owner").nextDeadline).toBe(expires);
    scheduler = createDeadlineScheduler(db, bus, emit);
    scheduler.close();
    scheduler = undefined;
    await new Promise((resolve) => setTimeout(resolve, 150));
    const before = events().length;
    scheduler = createDeadlineScheduler(db, bus, emit);
    await expect.poll(() => events().length).toBeGreaterThan(before);
    expect(changeClock(db, "owner").nextDeadline).toBeNull();
    expect(
      db
        .prepare(
          "SELECT attempts,lease_id,outcome FROM webhook_deliveries WHERE id='job'",
        )
        .get(),
    ).toEqual({ attempts: 0, lease_id: "lease", outcome: "unattempted" });
    scheduler.close();
    scheduler = createDeadlineScheduler(db, bus, emit);
    const settled = events().length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(events()).toHaveLength(settled);
  } finally {
    scheduler?.close();
    bus.close();
    db.close();
  }
});
