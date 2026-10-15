import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";

it.each([false, true])(
  "adds Gemini without losing connection references or null settings (rollback first: %s)",
  (rollback) => {
    const db = new Database(":memory:");
    try {
      db.pragma("foreign_keys = ON");
      for (const file of readdirSync("migrations")
        .filter((file) => file.endsWith(".sql") && file < "089")
        .sort())
        db.exec(readFileSync("migrations/" + file, "utf8"));
      db.exec(`INSERT INTO connections(id,owner_id,provider,label,secret,status,created_at) VALUES('existing','owner','codex','Account','encrypted','connected',1);
      INSERT INTO agents(id,owner_id,name,normalized_name,provider,connection_id,model,created_at) VALUES('agent','owner','Agent','agent','codex','existing','native-default',1);
      INSERT INTO preferences(owner_id,embedding_connection,embedding_model,embedding_enabled) VALUES('owner','existing','embedding',1);
      INSERT INTO folders(id,owner_id,name,kind,created_at) VALUES('project','owner','Project','project',1);
      INSERT INTO brief_state(owner_id,project_id,connection_id,model,enabled) VALUES('owner','project','existing','native-default',1);
      INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,created_at) VALUES('unconnected','other-owner','Unconnected','unconnected','codex','native-default',1);
      INSERT INTO preferences(owner_id) VALUES('other-owner');
      INSERT INTO folders(id,owner_id,name,kind,created_at) VALUES('other-project','other-owner','Other','project',1);
      INSERT INTO brief_state(owner_id,project_id) VALUES('other-owner','other-project');`);
      const tables = ["connections", "agents", "preferences", "brief_state"];
      const before = tables.map((table) =>
        db.prepare(`SELECT * FROM ${table}`).all(),
      );
      const migration = readFileSync(
        "migrations/089-gemini-connections.sql",
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
        expect(
          tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all()),
        ).toEqual(before);
        expect(
          db.prepare("SELECT 1 FROM schema_version WHERE version=89").get(),
        ).toBeUndefined();
      }
      db.transaction(() => db.exec(migration)).immediate();
      expect(
        tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all()),
      ).toEqual(before);
      db.exec(
        "INSERT INTO connections(id,owner_id,provider,label,secret,status,created_at) VALUES('gemini','owner','gemini','Gemini CLI','','connected',1)",
      );
      expect(() =>
        db.exec("UPDATE connections SET provider='unknown' WHERE id='gemini'"),
      ).toThrow(/CHECK/);
      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      db.close();
    }
  },
);
