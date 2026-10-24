import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const start = async (directory: string) => {
  const result = await exec(process.execPath, [
    "--import", "tsx", "--input-type=module", "-e",
    "const {db}=await import('./src/server/db.ts');if(db.pragma('foreign_key_check').length)throw Error('foreign keys');console.log(JSON.stringify(db.prepare('SELECT prefix AS version FROM schema_migrations ORDER BY prefix').all()));db.close();",
  ], { env: { ...process.env, LOOP_PROFILE: "server", LOOP_DATA_DIR: directory } });
  return JSON.parse(result.stdout) as { version: number }[];
};

it("upgrades run events without reusing deleted IDs and admits connection subjects without a run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "loop-event-upgrade-"));
  const db = new Database(join(directory, "loop.db"));
  try {
    db.pragma("foreign_keys=ON");
    db.transaction(() => {
      for (const name of readdirSync("migrations").filter((name) =>
        name.endsWith(".sql") && Number(name.split("-")[0]) < 107,
      ).sort()) db.exec(readFileSync(join("migrations", name), "utf8"));
    }).immediate();
    db.exec(`
      INSERT INTO runs(id,owner_id,input,state,idempotency_key,created_at,updated_at)
      VALUES('one','owner-one','Task','completed','one',1,1),('two','owner-two','Task','running','two',1,1);
      INSERT INTO events(id,owner_id,run_id,type,payload,created_at)
      VALUES(3,'owner-one','one','completed','{"message":"Done"}',11),
            (7,'owner-two','two','running','{}',12),
            (90000,'owner-one','one','progress','{"message":"pruned"}',13);
      DELETE FROM events WHERE id=90000;
    `);
    const snapshot = () => db.prepare("SELECT id,owner_id,run_id,type,payload,created_at FROM events ORDER BY id").all();
    const before = snapshot();
    const applied = await start(directory);
    expect(await start(directory)).toEqual(applied);
    expect(applied.filter(({ version }) => version === 107)).toHaveLength(1);
    expect(snapshot()).toEqual(before);
    expect(db.prepare("SELECT id,subject_kind,subject_id FROM events ORDER BY id").all()).toEqual([
      { id: 3, subject_kind: "run", subject_id: "one" },
      { id: 7, subject_kind: "run", subject_id: "two" },
    ]);
    expect(db.pragma("table_info(events)")).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "run_id", notnull: 0 }),
    ]));
    expect(db.pragma("foreign_key_list(events)")).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "runs", from: "run_id", on_delete: "CASCADE" }),
    ]));
    expect(db.pragma("index_list(events)")).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "event_cursor" }),
      expect.objectContaining({ name: "events_run" }),
    ]));
    const id = db.prepare("INSERT INTO events(owner_id,run_id,type,payload,created_at) VALUES('owner-one','one','completed','{}',14)").run().lastInsertRowid;
    expect(Number(id)).toBe(90001);
    expect(db.prepare("SELECT subject_kind,subject_id FROM events WHERE id=?").get(id)).toEqual({ subject_kind: "run", subject_id: "one" });
    db.exec("DELETE FROM runs");
    expect(db.prepare("SELECT id FROM events WHERE run_id IS NOT NULL").all()).toEqual([]);
    expect(db.prepare("SELECT id FROM events WHERE type='tombstone'").all()).toHaveLength(2);
    const connectionId = db.prepare("INSERT INTO events(owner_id,run_id,type,payload,created_at,subject_kind,subject_id) VALUES('owner-one',NULL,'connection.status','{\"status\":\"disconnected\"}',15,'connection','connection-one')").run().lastInsertRowid;
    expect(Number(connectionId)).toBeGreaterThan(90001);
    expect(db.prepare("SELECT run_id,subject_kind,subject_id FROM events WHERE id=?").get(connectionId)).toEqual({ run_id: null, subject_kind: "connection", subject_id: "connection-one" });
    expect(() => db.exec("INSERT INTO events(owner_id,run_id,type,payload,created_at) VALUES('owner','missing','queued','{}',1)")).toThrow(/FOREIGN KEY/);
    expect(() => db.exec("INSERT INTO events(owner_id,type,payload,created_at,subject_kind) VALUES('owner','connection.status','{}',1,'connection')")).toThrow(/CHECK/);
    expect(() => db.exec("INSERT INTO events(owner_id,type,payload,created_at,subject_kind,subject_id) VALUES('owner','queued','{}',1,'unknown','subject')")).toThrow(/CHECK/);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("serializes concurrent fresh database startup to one migration history", async () => {
  const directory = mkdtempSync(join(tmpdir(), "loop-event-fresh-"));
  try {
    const [one, two] = await Promise.all([start(directory), start(directory)]);
    expect(one).toEqual(two);
    expect(one.filter(({ version }) => version === 107)).toHaveLength(1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
