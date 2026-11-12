import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";

const priorMigrations = () =>
  readdirSync("migrations")
    .filter((file) => file.endsWith(".sql") && file < "159")
    .sort()
    .map((file) => readFileSync("migrations/" + file, "utf8"));

const migration = () =>
  readFileSync("migrations/159-artifact-role.sql", "utf8");

const insertArtifact = (
  db: Database.Database,
  id: string,
  kind: string,
  run: string | null,
  metadata: string,
  owner = "owner",
) =>
  db
    .prepare(
      "INSERT INTO artifacts(id,owner_id,title,kind,content,metadata,run_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,1)",
    )
    .run(id, owner, "Title", kind, "Content", metadata, run);

it("backfills every existing row with its declared role and enforces the set", () => {
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys = ON");
    priorMigrations().forEach((sql) => db.exec(sql));
    const owner = "owner",
      run = "run-1";
    db.prepare(
      "INSERT INTO runs(id,owner_id,input,state,idempotency_key,created_at,updated_at) VALUES(?,'owner','Input','completed','k',1,1)",
    ).run(run);
    // File: published with an uploaded marker.
    insertArtifact(db, "file", "file", run, '{"uploaded":true,"name":"a.png"}');
    // Upload: owned upload, no run.
    insertArtifact(
      db,
      "upload",
      "file",
      null,
      '{"upload":true,"objectId":"o1"}',
    );
    // Import: origin import, no run.
    insertArtifact(
      db,
      "import",
      "conversation",
      null,
      '{"origin":"import","importId":"i1"}',
    );
    // Answer: the run's checkpoint artifact, marked partial while running.
    insertArtifact(db, "answer", "markdown", run, '{"messageId":"m1"}');
    db.prepare(
      "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES('c1','owner',NULL,'Title',1)",
    ).run();
    db.prepare(
      "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES('m1','owner','c1','run-1','assistant','Answer','{}',1)",
    ).run();
    db.prepare(
      "INSERT INTO agent_checkpoints(run_id,message_id,artifact_id,history) VALUES(?,'m1','answer','[]')",
    ).run(run);
    // Trace: same run, not the checkpoint artifact (a tool result).
    insertArtifact(
      db,
      "trace",
      "markdown",
      run,
      '{"tool":"web_search_exa","fib":1}',
    );
    // Snippet: no run, no probes.
    insertArtifact(db, "snippet", "markdown", null, '{"snippet":true}');
    db.transaction(() => db.exec(migration())).immediate();
    const roleOf = (id: string) =>
      (
        db.prepare("SELECT role FROM artifacts WHERE id=?").get(id) as {
          role: string;
        }
      ).role;
    expect(roleOf("file")).toBe("file");
    expect(roleOf("upload")).toBe("upload");
    expect(roleOf("import")).toBe("import");
    expect(roleOf("answer")).toBe("answer");
    expect(roleOf("trace")).toBe("trace");
    expect(roleOf("snippet")).toBe("snippet");
    expect(
      db.prepare("SELECT count(*) n FROM artifacts WHERE role IS NULL").get(),
    ).toEqual({ n: 0 });
    // Inserts and updates without a role, or with an unknown one, fail.
    const insert = db.prepare(
      "INSERT INTO artifacts(id,owner_id,title,kind,role,content,metadata,created_at,updated_at) VALUES(?,?,'X','markdown',?, 'C', '{}',1,1)",
    );
    expect(() => insert.run("no-role", owner, null)).toThrow(
      /Unknown artifact role/,
    );
    expect(() => insert.run("bad-role", owner, "planner")).toThrow(
      /Unknown artifact role/,
    );
    expect(() => insert.run("ok-role", owner, "answer")).not.toThrow();
    expect(() =>
      db.prepare("UPDATE artifacts SET role='bogus' WHERE id='answer'").run(),
    ).toThrow(/Unknown artifact role/);
    expect(() =>
      db.prepare("UPDATE artifacts SET role=NULL WHERE id='answer'").run(),
    ).toThrow(/Unknown artifact role/);
  } finally {
    db.close();
  }
});

it("the guard aborts and rolls back when a row could be left without a role", () => {
  const db = new Database(":memory:");
  try {
    priorMigrations().forEach((sql) => db.exec(sql));
    insertArtifact(db, "one", "markdown", null, "{}");
    db.transaction(() => db.exec(migration())).immediate();
    // Every real shape is classified by the backfill, so the guard is a
    // safety net: exercise it by removing the enforcement trigger, leaving a
    // row without a role, and re-running the migration's guard block. The
    // NULLing happens inside the same transaction so the abort proves the
    // whole rollback (guard table, trigger and row change all revert).
    db.exec("DROP TRIGGER artifact_role_insert");
    db.exec("DROP TRIGGER artifact_role_update");
    expect(() =>
      db
        .transaction(() => {
          db.exec("UPDATE artifacts SET role=NULL");
          db.exec(`
            CREATE TABLE artifact_role_guard(checked INTEGER NOT NULL);
            CREATE TRIGGER artifact_role_guard_check BEFORE INSERT ON artifact_role_guard
            WHEN EXISTS(SELECT 1 FROM artifacts WHERE role IS NULL OR role NOT IN ('answer','trace','file','upload','import','snippet'))
            BEGIN
              SELECT RAISE(ABORT, 'Artifacts without a declared role remain; this version requires one for every row.');
            END;
            INSERT INTO artifact_role_guard VALUES(1);
            DROP TABLE artifact_role_guard;
          `);
          throw new Error("Fixture transaction aborted");
        })
        .immediate(),
    ).toThrow(/without a declared role/);
    // The rollback reverted the guard artifacts and the NULLed role.
    expect(
      db.prepare("SELECT role FROM artifacts WHERE id='one'").get(),
    ).toEqual({ role: "snippet" });
    expect(
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='artifact_role_guard'",
        )
        .get(),
    ).toBeUndefined();
  } finally {
    db.close();
  }
});
