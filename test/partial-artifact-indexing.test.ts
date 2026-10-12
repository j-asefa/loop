import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const migration = "079-partial-artifact-indexing.sql";

it("upgrades existing drafts, defers their indexes, and invalidates the indexed embedding on completion", () => {
  const db = new Database(":memory:");
  try {
    db.exec(
      "CREATE TABLE schema_version(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
    );
    for (const file of readdirSync("migrations")
      .filter((f) => f.endsWith(".sql"))
      .sort())
      if (file < migration)
        db.exec(readFileSync(join("migrations", file), "utf8"));
    const insert =
      db.prepare(`INSERT INTO artifacts(id,owner_id,title,kind,content,metadata,created_at,updated_at)
      VALUES(?,?,'Draft','markdown','initial',?,1,1)`);
    insert.run("draft", "alice", '{"partial":true}');
    insert.run("other", "bob", "{}");
    const content = (table: string, column: string, key: string) =>
      (
        db
          .prepare(`SELECT content FROM ${table} WHERE ${column}=?`)
          .get(key) as { content: string }
      ).content;
    const snapshot = () => ({
      artifact: content("artifacts", "id", "draft"),
      fts: content("artifact_fts", "artifact_id", "draft"),
      search: content("search_documents", "id", "artifact:draft"),
      searchFts: content("search_fts", "id", "artifact:draft"),
      revision: (
        db
          .prepare(
            "SELECT revision FROM feed_revisions WHERE entity='artifact' AND object_id='draft'",
          )
          .get() as { revision: number }
      ).revision,
    });
    const change = db.prepare(
      "UPDATE artifacts SET content=?,updated_at=updated_at+1 WHERE id='draft'",
    );
    const totalChanges = () =>
      (db.prepare("SELECT total_changes() n").get() as { n: number }).n;
    const baselineStart = totalChanges();
    change.run("before migration");
    const baselineWrites = totalChanges() - baselineStart;
    console.info(
      `Partial artifact update: ${baselineWrites} → 1 SQLite row changes (including FTS internals)`,
    );
    const before = snapshot();
    db.exec(readFileSync(join("migrations", migration), "utf8"));
    expect(snapshot()).toEqual(before); // No reset/backfill or history loss.
    db.prepare(
      "INSERT INTO embeddings VALUES('artifact:draft','alice','fixture','[1]','old-hash',1)",
    ).run();
    for (const text of ["first chunk", "final chunk"]) {
      const start = totalChanges();
      change.run(text);
      const writes = totalChanges() - start;
      expect(writes).toBe(1); // Just the artifact; includes nested/FTS writes otherwise.
      expect(baselineWrites).toBeGreaterThan(writes);
      expect(snapshot()).toEqual({ ...before, artifact: text });
      expect(db.prepare("SELECT count(*) n FROM embeddings").get()).toEqual({
        n: 1,
      });
    }
    // Only metadata changes at completion: old.content already equals new.content.
    db.exec(
      `UPDATE artifacts SET metadata='{"partial":false}' WHERE id='draft'`,
    );
    const completed = snapshot();
    expect(completed).toMatchObject({
      artifact: "final chunk",
      fts: "final chunk",
      search: "final chunk",
      searchFts: "final chunk",
    });
    expect(completed.revision).toBeGreaterThan(before.revision);
    expect(db.prepare("SELECT count(*) n FROM embeddings").get()).toEqual({
      n: 0,
    });
    expect(content("search_documents", "id", "artifact:other")).toBe("initial");
    expect(
      db
        .prepare(
          "SELECT artifact_id FROM artifact_fts WHERE artifact_fts MATCH 'final'",
        )
        .all(),
    ).toEqual([{ artifact_id: "draft" }]);
    expect(
      db
        .prepare("SELECT id FROM search_fts WHERE search_fts MATCH 'final'")
        .all(),
    ).toEqual([{ id: "artifact:draft" }]);

    // Completed edits still index immediately, including legacy metadata without partial.
    db.exec(
      "UPDATE artifacts SET metadata='{}',content='edited' WHERE id='draft'",
    );
    expect(snapshot()).toMatchObject({
      fts: "edited",
      search: "edited",
      searchFts: "edited",
    });
    const editRevision = snapshot().revision;
    db.exec(
      `UPDATE artifacts SET metadata='{"partial":true}' WHERE id='draft'`,
    );
    expect(snapshot().revision).toBeGreaterThan(editRevision); // removal delta
    const partialAgain = snapshot();
    change.run("unfinished"); // interruption leaves last indexed snapshot available
    expect(snapshot()).toEqual({ ...partialAgain, artifact: "unfinished" });
    db.exec("DELETE FROM artifacts WHERE id='draft'");
    expect(
      db.prepare("SELECT * FROM artifact_fts WHERE artifact_id='draft'").all(),
    ).toEqual([]);
    expect(
      db
        .prepare("SELECT * FROM search_documents WHERE id='artifact:draft'")
        .all(),
    ).toEqual([]);
    expect(
      db.prepare("SELECT * FROM search_fts WHERE id='artifact:draft'").all(),
    ).toEqual([]);
    expect(
      (
        db
          .prepare(
            "SELECT revision FROM feed_revisions WHERE object_id='draft' AND entity='artifact'",
          )
          .get() as { revision: number }
      ).revision,
    ).toBeGreaterThan(partialAgain.revision);
  } finally {
    db.close();
  }
});
