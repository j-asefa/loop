import { expect, it } from "vitest";
import Database from "better-sqlite3";
// Import before creating/migrating either connection: modules must stay lazy.
import * as watches from "../src/server/sql/pr-watches";
import { applyMigrations } from "../src/server/migrations";
import { installProjectionBoundary } from "../src/server/projected-database";

it("keeps lazy query statements on their supplied connection and inside the projection transaction", () => {
  const first = new Database(":memory:");
  const second = new Database(":memory:");
  try {
    for (const [db, owner] of [
      [first, "alice"],
      [second, "bob"],
    ] as const) {
      db.pragma("foreign_keys = ON");
      applyMigrations(db);
      db.prepare(
        "INSERT INTO conversations(id,owner_id,title,created_at) VALUES('thread',?,'Thread',10)",
      ).run(owner);
    }
    first.exec(
      "ALTER TABLE pr_watches ADD COLUMN private_column TEXT DEFAULT 'private'",
    );
    let projections = 0;
    installProjectionBoundary(first, () => {
      expect(first.inTransaction).toBe(true);
      projections++;
    });
    first
      .transaction(() => {
        watches.insert(
          first,
          "watch",
          "alice",
          "thread",
          "agent",
          "acme",
          "repo",
          42,
          null,
          10,
          10,
          10,
        );
        watches.schedule(first, 20, "watch");
      })
      .immediate();
    expect(projections).toBe(1);
    expect(watches.owned(first, "watch", "bob")).toBeUndefined();
    expect(watches.owned(first, "watch", "alice")).toMatchObject({
      id: "watch",
      next_poll_at: 20,
    });
    expect(watches.list(first, "bob", null, 0)).toEqual([]);
    expect(watches.threadDetails(first, "bob", "thread")).toEqual([]);
    expect(watches.pullStatus(first, "bob", "thread", 0)).toBeUndefined();
    expect([...watches.createdPulls(first, "bob", "thread")]).toEqual([]);
    expect(watches.get(second, "watch")).toBeUndefined();
    watches.insert(
      second,
      "watch",
      "bob",
      "thread",
      "agent",
      "other",
      "repo",
      43,
      null,
      10,
      10,
      10,
    );
    expect(watches.get(second, "watch")?.owner_id).toBe("bob");
    expect(watches.get(first, "watch")?.owner_id).toBe("alice");
    expect(watches.get(first, "watch")).not.toHaveProperty("private_column");
    expect(watches.threadDetails(second, "bob", "thread")[0]?.number).toBe(43);
    expect(watches.threadDetails(first, "bob", "thread")).toEqual([]);
    // Reusing the cached write must still drain the production boundary.
    watches.schedule(first, 30, "watch");
    expect(projections).toBe(2);
    expect(() =>
      first
        .transaction(() => {
          watches.schedule(first, 40, "watch");
          throw new Error("rollback");
        })
        .immediate(),
    ).toThrow("rollback");
    expect(watches.get(first, "watch")?.next_poll_at).toBe(30);
    expect(projections).toBe(2);
    expect(watches.claim(first, 60, "watch", 30).changes).toBe(1);
    expect(watches.claim(first, 60, "watch", 30).changes).toBe(0);
    watches.end(first, "Stopped", 40, "watch");
    expect(
      watches.activeForPull(first, "alice", "thread", "acme", "repo", 42),
    ).toBeUndefined();
    expect(
      watches.latestForPull(first, "alice", "thread", "ACME", "REPO", 42)
        ?.state,
    ).toBe("stopped");
  } finally {
    first.close();
    second.close();
  }
});

it("resumes only a paused watch, so a stop committed first is kept", () => {
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys = ON");
    applyMigrations(db);
    db.prepare(
      "INSERT INTO conversations(id,owner_id,title,created_at) VALUES('thread','alice','Thread',10)",
    ).run();
    watches.insert(
      db,
      "watch",
      "alice",
      "thread",
      "agent",
      "acme",
      "repo",
      42,
      null,
      10,
      10,
      10,
    );
    watches.pause(db, "Hourly limit", 20, "watch");
    // The API read the watch as paused; the worker then ends it (merged).
    watches.end(db, "The pull request merged.", 30, "watch");
    expect(watches.resume(db, 40, "watch").changes).toBe(0);
    expect(watches.owned(db, "watch", "alice")).toMatchObject({
      state: "stopped",
      ended_reason: "The pull request merged.",
    });
  } finally {
    db.close();
  }
});
