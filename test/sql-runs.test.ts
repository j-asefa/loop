import { expect, it } from "vitest";
import Database from "better-sqlite3";
import * as runs from "../src/server/sql/runs";
import { applyMigrations } from "../src/server/migrations";

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

it("keeps attention query variants owner-scoped and preserves waiting-child display state", () => {
  const { db, insert } = fixture();
  try {
    insert("a", "alice", 1, "team-a");
    insert("b", "alice", 2, "team-b");
    insert("foreign", "bob", 3, "team-a");
    runs.claimLease(db, "running", null, 4, 4, 4, "a");
    runs.setResult(db, "done", "b");
    runs.transitionState(
      db,
      "completed",
      5,
      "completed",
      "completed",
      5,
      5,
      5,
      "completed",
      "b",
    );
    expect(runs.attention(db, "alice", [], false).map((r) => r.id)).toEqual([
      "b",
      "a",
    ]);
    expect(runs.attention(db, "alice", ["team-a"], false)).toMatchObject([
      { id: "a", state: "waiting_children" },
    ]);
    expect(
      runs.attention(db, "alice", ["team-a", "team-b"], true).map((r) => r.id),
    ).toEqual(["a"]);
    // Revisit the same SQL shape with different bindings after other variants.
    expect(
      runs.attention(db, "alice", ["team-b"], false).map((r) => r.id),
    ).toEqual(["b"]);
    expect(runs.ownedControl(db, "foreign", "alice")).toBeUndefined();
  } finally {
    db.close();
  }
});

it("rejects malformed claim candidates individually while control and notice reads ignore payloads", () => {
  const { db, insert } = fixture();
  try {
    insert("damaged", "alice", 1);
    insert("healthy", "alice", 2);
    db.prepare("UPDATE runs SET payload=? WHERE id=?").run(
      '{"maxTokens":0}',
      "damaged",
    );
    const rejected: string[] = [];
    expect(
      runs
        .claimCandidates(db, (row, error) => {
          rejected.push(row.id);
          expect(error.table).toBe("runs");
        })
        .map((row) => row.id),
    ).toEqual(["healthy"]);
    expect(rejected).toEqual(["damaged"]);
    expect(runs.ownedControl(db, "damaged", "alice")?.state).toBe("queued");
    expect(runs.ownedNotice(db, "damaged", "alice")?.id).toBe("damaged");
  } finally {
    db.close();
  }
});

it("keeps created-time and insertion-order continuation lookups distinct", () => {
  const { db, insert } = fixture();
  try {
    insert("newer-time", "alice", 20);
    insert("later-insert", "alice", 10);
    expect(runs.latestConversationPayload(db, "alice", "alice")?.id).toBe(
      "newer-time",
    );
    expect(
      runs.latestConversationPayloadByRowid(db, "alice", "alice")?.id,
    ).toBe("later-insert");
    expect(runs.latestConversationPayload(db, "bob", "alice")).toBeUndefined();
  } finally {
    db.close();
  }
});
