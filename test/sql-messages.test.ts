import { expect, it } from "vitest";
import Database from "better-sqlite3";
import * as runs from "../src/server/sql/runs";
import * as messages from "../src/server/sql/messages";
import { applyMigrations } from "../src/server/migrations";
import { installProjectionBoundary } from "../src/server/projected-database";

function fixture() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applyMigrations(db);
  for (const owner of ["alice", "bob"])
    db.prepare(
      "INSERT INTO conversations(id,owner_id,title,created_at) VALUES(?,?,?,0)",
    ).run(owner, owner, owner);
  const insert = (id: string, owner: string, created: number, team?: string) =>
    runs.insertQueued(
      db,
      id,
      owner,
      null,
      owner,
      "agent",
      id,
      id,
      JSON.stringify(team ? { teamId: team } : {}),
      created,
      created,
    );
  return { db, insert };
}

it("preserves message insert defaults, owner reads and atomic cached updates", () => {
  const { db, insert } = fixture();
  try {
    insert("run", "alice", 1);
    let projected = 0;
    installProjectionBoundary(db, () => {
      expect(db.inTransaction).toBe(true);
      projected++;
    });
    db.transaction(() => {
      messages.insert(
        db,
        "explicit",
        "alice",
        "alice",
        "run",
        "user",
        "hello",
        '{"personal":true}',
        2,
      );
      messages.insertNativePlaceholder(
        db,
        "placeholder",
        "alice",
        "alice",
        "run",
        4,
      );
    }).immediate();
    expect(projected).toBe(1);
    expect(messages.owned(db, "explicit", "bob")).toBeUndefined();
    expect(messages.owned(db, "explicit", "alice")?.metadata).toBe(
      '{"personal":true}',
    );
    expect(messages.owned(db, "placeholder", "alice")).toMatchObject({
      role: "assistant",
      content: "",
      metadata: "{}",
    });
    expect(() =>
      db
        .transaction(() => {
          messages.updateContentAndMetadata(
            db,
            "changed",
            '{"final":true}',
            "placeholder",
          );
          runs.setResult(db, "changed", "run");
          throw new Error("rollback");
        })
        .immediate(),
    ).toThrow("rollback");
    expect(messages.owned(db, "placeholder", "alice")?.content).toBe("");
    expect(runs.get(db, "run")?.result).toBeNull();
    expect(projected).toBe(1);
    messages.updateContentAndMetadata(
      db,
      "answer",
      '{"final":true}',
      "placeholder",
    );
    expect(projected).toBe(2);
  } finally {
    db.close();
  }
});
