import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";

it("preserves native dispatch identities and history while admitting Pi storage", () => {
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys = ON");
    db.exec(`CREATE TABLE schema_version(version INTEGER PRIMARY KEY, applied_at INTEGER);
      CREATE TABLE conversations(id TEXT PRIMARY KEY);
      CREATE TABLE folders(id TEXT PRIMARY KEY);
      CREATE TABLE runtime_hosts(id TEXT PRIMARY KEY);
      CREATE TABLE runs(id TEXT PRIMARY KEY);
      CREATE TABLE approvals(id TEXT PRIMARY KEY);
      INSERT INTO runtime_hosts VALUES('host');`);
    db.exec(readFileSync("migrations/027-hapi-execution.sql", "utf8"));
    // Version 34 belongs to the independent personal-history migration (PR #31).
    db.exec("INSERT INTO schema_version VALUES(34, 0)");
    db.exec(`INSERT INTO execution_environments
      (host_id,owner_id,instance_id,namespace,credential_hash,certificate_fingerprint)
      VALUES('host','owner','instance','namespace','hash','fingerprint')`);
    for (const flavor of ["codex", "claude"]) {
      db.prepare("INSERT INTO conversations(id) VALUES(?)").run(flavor);
      db.prepare("INSERT INTO runs VALUES(?)").run(flavor);
      db.prepare(
        `INSERT INTO native_sessions VALUES(
        ?, 'owner', 'host', 7, ?, 'billing', ?, ?, ?,
        '["ancestor"]', 'active', 4, 17, 123, 'cursor', 0, 'fixture-secret', 'hash', 99
      )`,
      ).run(
        flavor,
        flavor,
        "launch-" + flavor,
        "hub-" + flavor,
        "thread-" + flavor,
      );
      db.prepare(
        `INSERT INTO native_dispatches VALUES(
        ?, ?, ?, 'payload-hash', 'envelope', 'billing', 'host', 7,
        'unknown', 'evidence', 'native-turn', 124, 1, 'uncertain', 120, 125
      )`,
      ).run(flavor, flavor, "local-" + flavor);
      db.prepare(
        "INSERT INTO native_projection VALUES(?, 'external', 'revision', 'message', 'payload')",
      ).run(flavor);
    }
    const tables = [
      "native_sessions",
      "native_dispatches",
      "native_projection",
    ];
    const snapshot = () =>
      tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all());
    const before = snapshot();
    expect(() =>
      db
        .transaction(() => {
          db.exec(readFileSync("migrations/035-hapi-pi.sql", "utf8"));
          throw new Error("later migration failed");
        })
        .immediate(),
    ).toThrow("later migration failed");
    expect(snapshot()).toEqual(before);
    expect(
      db.prepare("SELECT version FROM schema_version WHERE version=35").get(),
    ).toBeUndefined();
    expect(() => db.exec("UPDATE native_sessions SET flavor='pi'")).toThrow();
    db.transaction(() => {
      db.transaction(() =>
        db.exec(readFileSync("migrations/035-hapi-pi.sql", "utf8")),
      ).immediate();
    }).immediate();
    expect(snapshot()).toEqual(before);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    db.exec(
      "UPDATE native_sessions SET flavor='pi' WHERE conversation_id='codex'",
    );
    for (const statement of [
      "UPDATE native_sessions SET flavor='cursor' WHERE conversation_id='codex'",
      "UPDATE native_sessions SET launch_id='launch-claude' WHERE conversation_id='codex'",
      "UPDATE native_dispatches SET local_id='local-claude' WHERE run_id='codex'",
      "UPDATE native_projection SET conversation_id='missing'",
      "DELETE FROM native_sessions WHERE conversation_id='codex'",
    ])
      expect(() => db.exec(statement)).toThrow();
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='native_dispatch_state'",
        )
        .get(),
    ).toEqual({ name: "native_dispatch_state" });
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_temp_master WHERE name LIKE 'migration035_%'",
        )
        .all(),
    ).toEqual([]);
  } finally {
    db.close();
  }
});
