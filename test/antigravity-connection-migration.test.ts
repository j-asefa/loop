import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";

const triggers = (db: Database.Database) =>
  db
    .prepare(
      "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='connections' ORDER BY name",
    )
    .all();

it.each([false, true])(
  "adds Antigravity without losing connection references, settings or triggers (rollback first: %s)",
  (rollback) => {
    const db = new Database(":memory:");
    try {
      db.pragma("foreign_keys = ON");
      for (const file of readdirSync("migrations")
        .filter((file) => file.endsWith(".sql") && file < "134")
        .sort())
        db.exec(readFileSync("migrations/" + file, "utf8"));
      db.exec(`INSERT INTO connections(id,owner_id,provider,label,secret,status,created_at) VALUES('existing','owner','gemini','Account','encrypted','connected',1);
      INSERT INTO agents(id,owner_id,name,normalized_name,provider,connection_id,model,created_at) VALUES('agent','owner','Agent','agent','gemini','existing','native-default',1);
      INSERT INTO preferences(owner_id,embedding_connection,embedding_model,embedding_enabled) VALUES('owner','existing','embedding',1);
      INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,created_at) VALUES('unconnected','other-owner','Unconnected','unconnected','codex','native-default',1);
      INSERT INTO preferences(owner_id) VALUES('other-owner');`);
      db.exec(`INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES('legacy-chat','owner','agent','Gemini history',1);
      INSERT INTO companion_sessions(worktree_agent_id,conversation_id,harness,native_id,project,generation,state,updated_at) VALUES('fixture-agent','legacy-chat','gemini','original-gemini-session','/original/project','old-generation','disconnected',1);
      INSERT INTO harnesses(name,options,billing,capabilities,models,updated_at) VALUES('gemini','{"executable":"/custom/gemini","billing":"existing"}','{}','{}','[]',1);`);
      const tables = [
        "connections",
        "agents",
        "preferences",
        "companion_sessions",
        "harnesses",
      ];
      const rows = () =>
        tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all());
      const before = rows();
      const beforeTriggers = triggers(db);
      expect(beforeTriggers).toHaveLength(10);
      const migration = readFileSync(
        "migrations/134-antigravity-connections.sql",
        "utf8",
      );
      if (rollback) {
        expect(() =>
          db
            .transaction(() => {
              db.exec(migration);
              throw new Error("Fixture transaction aborted");
            })
            .immediate(),
        ).toThrow("Fixture transaction aborted");
        expect(rows()).toEqual(before);
        expect(
          db.prepare("SELECT 1 FROM schema_version WHERE version=134").get(),
        ).toBeUndefined();
      }
      db.transaction(() => db.exec(migration)).immediate();
      expect(rows()).toEqual(before);
      // The rebuild drops the table's triggers; the migration restores them.
      expect(triggers(db)).toEqual(beforeTriggers);
      const events = () =>
        (
          db
            .prepare(
              "SELECT count(*) n FROM events WHERE subject_id='antigravity'",
            )
            .get() as { n: number }
        ).n;
      db.exec(
        "INSERT INTO connections(id,owner_id,provider,label,secret,status,created_at) VALUES('antigravity','owner','antigravity','Antigravity','','connected',1)",
      );
      expect(events()).toBe(1);
      expect(() =>
        db.exec(
          "UPDATE connections SET provider='unknown' WHERE id='antigravity'",
        ),
      ).toThrow(/CHECK/);
      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      db.close();
    }
  },
);
