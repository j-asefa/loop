import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";

it("upgrades populated pre-ACP connections without losing bindings or embedding preferences", () => {
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys = ON");
    for (const file of readdirSync("migrations")
      .filter((f) => f.endsWith(".sql") && f < "031")
      .sort())
      db.exec(readFileSync("migrations/" + file, "utf8"));
    db.exec(`INSERT INTO connections(id,owner_id,provider,label,secret,status,created_at) VALUES('direct','owner','codex','Existing','secret','connected',1);
      INSERT INTO agents(id,owner_id,name,normalized_name,provider,connection_id,model,created_at) VALUES('agent','owner','Agent','agent','codex','direct','default',1);
      INSERT INTO preferences(owner_id,embedding_connection,embedding_model,embedding_enabled) VALUES('owner','direct','embedding',1);
      INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES('conversation','owner','agent','Preserved',1);
      INSERT INTO companion_sessions(conversation_id,harness,project,native_id,generation,state,updated_at) VALUES('conversation','codex','/project','thread','generation','idle',1);`);
    const tables = [
      "connections",
      "agents",
      "preferences",
      "conversations",
      "companion_sessions",
    ];
    const before = tables.map((t) => db.prepare(`SELECT * FROM ${t}`).all());
    db.transaction(() =>
      db.exec(readFileSync("migrations/031-acp-connections.sql", "utf8")),
    ).immediate();
    expect(tables.map((t) => db.prepare(`SELECT * FROM ${t}`).all())).toEqual(
      before,
    );
    db.exec(
      `INSERT INTO connections(id,owner_id,provider,label,secret,status,created_at) VALUES('acp','owner','acp','ACP','','connected',1)`,
    );
    expect(() =>
      db.exec(`UPDATE connections SET provider='unknown' WHERE id='acp'`),
    ).toThrow(/CHECK/);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  } finally {
    db.close();
  }
});
