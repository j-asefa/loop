import { afterAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const directory = mkdtempSync(join(tmpdir(), "loop-event-webhooks-"));
vi.stubEnv("LOOP_DATA_DIR", directory);
vi.stubEnv("LOOP_ENCRYPTION_KEY", randomBytes(32).toString("hex"));
const { db, emit, changes, deadlines } = await import("../src/server/db");
afterAll(() => {
  deadlines.close();
  changes.close();
  db.close();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

it("commits a stopped event and its owned webhook together without a producer enqueue call", () => {
  db.prepare(
    "INSERT INTO runs(id,owner_id,input,state,idempotency_key,created_at,updated_at) VALUES('run','owner','fixture','running','key',1,1)",
  ).run();
  for (const owner of ["owner", "other"])
    db.prepare(
      `INSERT INTO webhook_subscriptions(id,owner_id,url,secret_sealed,creation_digest,kinds,local,state,created_at)
       VALUES(?,?,'https://example.com','','','["run.stopped"]',0,'active',0)`,
    ).run(owner, owner);
  const events = () =>
    db
      .prepare("SELECT id FROM events WHERE run_id='run' AND type='completed'")
      .all();
  const deliveries = () =>
    db.prepare("SELECT subscription_id,event_id FROM webhook_deliveries").all();
  const state = () => db.prepare("SELECT state FROM runs WHERE id='run'").get();
  const complete = () => {
    db.prepare("UPDATE runs SET state='completed' WHERE id='run'").run();
    return emit("owner", "run", "completed", {});
  };
  expect(() =>
    db
      .transaction(() => {
        complete();
        expect(deliveries()).toHaveLength(1);
        throw new Error("Outer rollback");
      })
      .immediate(),
  ).toThrow("Outer rollback");
  expect(events()).toEqual([]);
  expect(deliveries()).toEqual([]);
  expect(state()).toEqual({ state: "running" });

  db.exec(`CREATE TRIGGER reject_outbox BEFORE INSERT ON webhook_deliveries
    BEGIN SELECT RAISE(ABORT,'Fixture outbox failure'); END`);
  expect(() => db.transaction(complete).immediate()).toThrow(
    "Fixture outbox failure",
  );
  expect(events()).toEqual([]);
  expect(deliveries()).toEqual([]);
  expect(state()).toEqual({ state: "running" });
  db.exec("DROP TRIGGER reject_outbox");

  const event = db.transaction(complete).immediate();
  expect(events()).toEqual([{ id: Number(event) }]);
  expect(deliveries()).toEqual([
    { subscription_id: "owner", event_id: Number(event) },
  ]);
  expect(state()).toEqual({ state: "completed" });
});
