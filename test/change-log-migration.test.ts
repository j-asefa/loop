import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

it("upgrades existing subjects, keeps deletion tombstones and watermark through cascades, and rolls them back atomically", () => {
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys=ON");
    db.transaction(() => {
      for (const name of readdirSync("migrations").filter((name) => name.endsWith(".sql") && Number(name.split("-")[0]) <= 107).sort())
        db.exec(readFileSync(join("migrations", name), "utf8"));
    }).immediate();
    db.exec(`INSERT INTO conversations(id,owner_id,title,created_at) VALUES('thread','owner','Before',1);
      INSERT INTO runs(id,owner_id,conversation_id,input,state,idempotency_key,created_at,updated_at)
      VALUES('run','owner','thread','Prompt','completed','key',1,1);
      INSERT INTO events(id,owner_id,run_id,type,payload,created_at) VALUES(999,'owner','run','completed','{}',1);
      DELETE FROM events WHERE id=999;`);
    db.exec(readFileSync("migrations/108-complete-change-log.sql", "utf8"));
    const initial = db.prepare("SELECT * FROM change_watermark WHERE owner_id='owner'").get() as any;
    expect(initial.last_event_id).toBe(999);
    expect(initial.epoch).toMatch(/^[a-f0-9]{32}$/);
    db.exec("INSERT INTO events(owner_id,run_id,type,payload,created_at) VALUES('owner','run','completed','{}',1)");
    expect((db.prepare("SELECT max(id) id FROM events").get() as any).id).toBe(1000);
    const before = db.prepare("SELECT * FROM change_watermark").all();
    expect(() => db.transaction(() => { db.exec("DELETE FROM runs WHERE id='run'"); throw Error("rollback"); }).immediate()).toThrow("rollback");
    expect(db.prepare("SELECT * FROM change_watermark").all()).toEqual(before);
    expect(db.prepare("SELECT 1 FROM events WHERE run_id='run'").get()).toBeTruthy();
    db.exec("DELETE FROM runs WHERE id='run'");
    expect(db.prepare("SELECT 1 FROM events WHERE run_id='run'").get()).toBeUndefined();
    const tombstone = db.prepare("SELECT * FROM events WHERE type='tombstone'").get() as any;
    expect(tombstone).toMatchObject({ owner_id: "owner", run_id: null, subject_kind: "collection", subject_id: "runs" });
    expect(JSON.parse(tombstone.payload).removed).toEqual({ kind: "run", id: "run" });
    const after = db.prepare("SELECT * FROM change_watermark WHERE owner_id='owner'").get() as any;
    expect(after.epoch).toBe(initial.epoch);
    expect(after.last_event_id).toBeGreaterThanOrEqual(tombstone.id);
    // Even a pruned highest surviving row cannot lower replay bounds.
    db.exec("DELETE FROM events");
    expect(db.prepare("SELECT * FROM change_watermark WHERE owner_id='owner'").get()).toEqual(after);
    expect(() => db.exec("INSERT INTO events(owner_id,run_id,type,payload,created_at,subject_kind,subject_id) VALUES('owner',NULL,'invalidate','{}',1,'run','run')")).toThrow(/CHECK/);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("index_list(events)")).toEqual(expect.arrayContaining([expect.objectContaining({ name: "events_subject" })]));
  } finally { db.close(); }
});

it("tracks the final expiry when another production trigger changes an inserted approval", () => {
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys=ON");
    for (const name of readdirSync("migrations").filter(name => name.endsWith(".sql")).sort())
      db.exec(readFileSync(join("migrations", name), "utf8"));
    db.exec(`INSERT INTO runs(id,owner_id,input,state,idempotency_key,created_at,updated_at)
      VALUES('run','owner','Prompt','awaiting_approval','key',1,1);
      CREATE TEMP TRIGGER shorten_approval AFTER INSERT ON approvals BEGIN
        UPDATE approvals SET expires_at=NEW.created_at+200 WHERE id=NEW.id;
      END;`);
    expect(() => db.exec("INSERT INTO approvals(id,owner_id,run_id,digest,request,state,created_at,expires_at) VALUES('approval','owner','run','digest','{}','pending',1000,86401000)")).not.toThrow();
    expect(db.prepare("SELECT expires_at FROM change_expiries WHERE subject_id='approval'").get()).toEqual({ expires_at: 1200 });
  } finally { db.close(); }
});
