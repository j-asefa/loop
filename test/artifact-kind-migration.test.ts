import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";

const priorMigrations = () =>
  readdirSync("migrations")
    .filter((file) => file.endsWith(".sql") && file < "156")
    .sort()
    .map((file) => readFileSync("migrations/" + file, "utf8"));

const migration = () =>
  readFileSync("migrations/156-artifact-kind-check.sql", "utf8");

const insertArtifact = (
  db: Database.Database,
  id: string,
  kind: string,
  owner = "owner",
) =>
  db
    .prepare(
      "INSERT INTO artifacts(id,owner_id,title,kind,content,metadata,created_at,updated_at) VALUES(?,?,?,?,?,?,1,1)",
    )
    .run(id, owner, "Title", kind, "Content", "{}");

it("migrates valid kinds and enforces the set at insert and update", () => {
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys = ON");
    priorMigrations().forEach((sql) => db.exec(sql));
    // Rows carrying every kind the current build writes survive the migration.
    for (const kind of [
      "code",
      "markdown",
      "image",
      "github_pr",
      "chart",
      "table",
      "diagram",
      "file",
      "conversation",
    ])
      insertArtifact(db, "ok-" + kind, kind);
    db.transaction(() => db.exec(migration())).immediate();
    expect(db.prepare("SELECT count(*) n FROM artifacts").get()).toEqual({
      n: 9,
    });
    expect(
      db.prepare("SELECT kind,content FROM artifacts WHERE id='ok-code'").get(),
    ).toEqual({ kind: "code", content: "Content" });
    // Already-upgraded databases need the widened triggers too.
    db.exec(
      "DROP TRIGGER artifact_kind_insert; DROP TRIGGER artifact_kind_update",
    );
    const oldTriggers = migration()
      .slice(migration().indexOf("CREATE TRIGGER artifact_kind_insert"))
      .replaceAll("'code',", "");
    db.exec(oldTriggers);
    expect(() => insertArtifact(db, "code-after-upgrade", "code")).toThrow(
      /Unknown artifact kind/,
    );
    db.exec(readFileSync("migrations/163-released-artifact-kinds.sql", "utf8"));
    insertArtifact(db, "code-after-upgrade", "code");
    db.prepare(
      "UPDATE artifacts SET kind='code' WHERE id='code-after-upgrade'",
    ).run();
    // Insert and update with an unknown kind fail at the database.
    expect(() => insertArtifact(db, "bad", "unknown-kind")).toThrow(
      /Unknown artifact kind/,
    );
    expect(() =>
      db
        .prepare("UPDATE artifacts SET kind='bogus' WHERE id='ok-markdown'")
        .run(),
    ).toThrow(/Unknown artifact kind/);
    expect(() =>
      db
        .prepare(
          "UPDATE artifacts SET kind='conversation' WHERE id='ok-markdown'",
        )
        .run(),
    ).not.toThrow();
  } finally {
    db.close();
  }
});

it("refuses to migrate a database already holding an unknown kind and rolls back", () => {
  const db = new Database(":memory:");
  try {
    priorMigrations().forEach((sql) => db.exec(sql));
    insertArtifact(db, "legacy", "unknown-kind");
    expect(() =>
      db
        .transaction(() => {
          db.exec(migration());
          throw new Error("Fixture transaction aborted");
        })
        .immediate(),
    ).toThrow(/unknown kind/);
    expect(
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='artifact_kind_insert'",
        )
        .get(),
    ).toBeUndefined();
  } finally {
    db.close();
  }
});
