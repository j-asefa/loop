import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";

const files = readdirSync("migrations")
  .filter((file) => /^\d+.*\.sql$/.test(file))
  .sort();
const upTo = (db: Database.Database, stop: string) => {
  for (const file of files) {
    if (file.startsWith(stop)) break;
    db.exec(readFileSync("migrations/" + file, "utf8"));
  }
};

// later_items is rebuilt to accept the 'story' kind, because SQLite cannot
// alter a CHECK constraint. A rebuild that loses a row, a column or an index
// is worse than one that fails, so this runs the real migration.
it("rebuilds later_items for saved stories without losing anything", () => {
  const db = new Database(":memory:");
  try {
    upTo(db, "059");
    db.prepare(
      "INSERT INTO conversations(id,owner_id,title,created_at) VALUES('c','owner','Thread',0)",
    ).run();
    for (const [index, kind] of [
      "conversation",
      "artifact",
      "message",
    ].entries())
      db.prepare(
        `INSERT INTO later_items(id,owner_id,kind,target_id,condition,due_at,project_id,created_at,surfaced_at,done_at,snoozes)
         VALUES(?,'owner',?,?,'time',?,NULL,?,NULL,NULL,?)`,
      ).run(kind, kind, "target-" + kind, 1000 + index, index, index);
    // A finished reminder, which the unique index allows alongside an open one.
    db.prepare(
      `INSERT INTO later_items(id,owner_id,kind,target_id,condition,due_at,created_at,done_at,snoozes)
       VALUES('done','owner','conversation','target-conversation','time',1,1,2,0)`,
    ).run();
    const before = db
      .prepare("SELECT * FROM later_items ORDER BY id")
      .all() as Record<string, unknown>[];

    db.exec(readFileSync("migrations/059-feed-reads.sql", "utf8"));

    expect(db.prepare("SELECT * FROM later_items ORDER BY id").all()).toEqual(
      before,
    );
    expect(
      (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='later_items' AND name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all() as { name: string }[]
      ).map((row) => row.name),
    ).toEqual(["later_items_open", "later_items_waiting"]);
    // The new kind is accepted and the old constraint still holds.
    db.prepare(
      "INSERT INTO later_items(id,owner_id,kind,target_id,condition,due_at,created_at) VALUES('s','owner','story','hackernews:1','time',9,9)",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO later_items(id,owner_id,kind,target_id,condition,created_at) VALUES('bad','owner','nonsense','x','time',9)",
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
    // Two open reminders for the same story are still refused.
    expect(() =>
      db
        .prepare(
          "INSERT INTO later_items(id,owner_id,kind,target_id,condition,due_at,created_at) VALUES('s2','owner','story','hackernews:1','time',9,9)",
        )
        .run(),
    ).toThrow(/UNIQUE constraint failed/);
    expect(
      db.pragma("table_info(feed_subscriptions)") as { name: string }[],
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "read_through_at" }),
      ]),
    );
  } finally {
    db.close();
  }
});

it("refuses a rebuild that would lose a row", () => {
  const db = new Database(":memory:");
  try {
    // The guard the migration uses, with a count that does not match: it has
    // to fail rather than let the rebuild drop a row.
    db.exec(
      "CREATE TABLE later_items(id TEXT); CREATE TABLE later_items_old(id TEXT)",
    );
    db.prepare("INSERT INTO later_items_old VALUES('kept')").run();
    const guard = readFileSync("migrations/059-feed-reads.sql", "utf8")
      .split("\n")
      .filter((line) => line.includes("later_items_rebuilt"))
      .join("\n");
    expect(() => db.exec(guard)).toThrow(/CHECK constraint failed/);
    // And passes when every row came across. (The real migration runs inside a
    // transaction, so a failed guard rolls the temporary table back with it.)
    db.exec("DROP TABLE later_items_rebuilt");
    db.prepare("INSERT INTO later_items VALUES('kept')").run();
    expect(() => db.exec(guard)).not.toThrow();
  } finally {
    db.close();
  }
});

it("builds the feed store from nothing", () => {
  const db = new Database(":memory:");
  try {
    for (const file of files)
      db.exec(readFileSync("migrations/" + file, "utf8"));
    for (const table of ["feed_stories", "feed_state", "feed_reads"])
      expect(
        db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
          .get(table),
      ).toBeTruthy();
  } finally {
    db.close();
  }
});
