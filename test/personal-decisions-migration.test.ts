import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";

it("recovers evidenced personal decisions without inventing old answers or treating automatic approvals as personal", () => {
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys = ON");
    db.exec(
      "CREATE TABLE schema_version(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL)",
    );
    for (const file of readdirSync("migrations")
      .filter((file) => file.endsWith(".sql") && file < "116")
      .sort())
      db.exec(readFileSync("migrations/" + file, "utf8"));
    db.exec(`INSERT INTO conversations(id,owner_id,title,created_at) VALUES('thread','owner','Original conversation',1);
      INSERT INTO runs(id,owner_id,conversation_id,input,state,idempotency_key,payload,created_at,updated_at)
      VALUES('run','owner','thread','Original task','completed','run','{}',1,1)`);
    const approval = db.prepare(
      "INSERT INTO approvals VALUES(?,'owner','run',?,'{}',?,NULL,1,1000)",
    );
    const event = db.prepare(
      "INSERT INTO events(owner_id,run_id,type,payload,created_at) VALUES(?,'run',?,?,?)",
    );
    for (const [id, state] of [
      ["manual", "completed"],
      ["denied", "rejected"],
      ["native-tool", "unknown"],
      ["auto", "completed"],
      ["closed", "rejected"],
      ["unproven", "approved"],
    ])
      approval.run(id, id, state);
    event.run("owner", "queued", '{"approvalId":"manual"}', 100);
    event.run("owner", "failed", '{"approvalId":"denied"}', 101);
    event.run(
      "owner",
      "approval.decided",
      '{"approvalId":"native-tool","decision":"approve","origin":"loop"}',
      102,
    );
    event.run("owner", "queued", '{"approvalId":"auto"}', 103);
    event.run("owner", "approval.auto_approved", '{"approvalId":"auto"}', 104);
    event.run("other", "queued", '{"approvalId":"unproven"}', 105);
    event.run("owner", "approval.decided", "{unreadable legacy event", 106);
    const native =
      db.prepare(`INSERT INTO native_decisions(id,run_id,conversation_id,generation,native_id,request,state,command_id,created_at)
      VALUES(?,'run','thread','generation',?,'{"kind":"question","title":"Choose","questions":[{"id":"q","title":"Which?"}]}',?,?,2)`);
    native.run("answered", "answered", "resolved", "manual-command");
    native.run("uncertain", "uncertain", "unknown", "uncertain-command");
    native.run("automatic", "automatic", "resolved", "auto:automatic");
    native.run("external", "external", "resolved", null);
    native.run("expired", "expired", "expired", null);
    // An old expired command cannot reveal whether delivery was refused or
    // uncertain. Preserve its request evidence without inventing an answer.
    native.run(
      "legacy-expired-attempt",
      "legacy-expired-attempt",
      "expired",
      "legacy-command",
    );
    db.exec(readFileSync("migrations/116-personal-decisions.sql", "utf8"));
    db.exec(
      readFileSync("migrations/117-personal-decision-previews.sql", "utf8"),
    );
    expect(
      db
        .prepare("SELECT DISTINCT response_truncated FROM personal_decisions")
        .all(),
    ).toEqual([{ response_truncated: 0 }]);
    expect(
      db
        .prepare(
          "SELECT id,response,created_at FROM personal_decisions ORDER BY id",
        )
        .all(),
    ).toEqual([
      {
        id: "approval:denied",
        response: '{"choice":"reject"}',
        created_at: 101,
      },
      {
        id: "approval:manual",
        response: '{"choice":"approve"}',
        created_at: 100,
      },
      {
        id: "approval:native-tool",
        response: '{"choice":"approve"}',
        created_at: 102,
      },
      { id: "native:answered", response: null, created_at: 2 },
      { id: "native:legacy-expired-attempt", response: null, created_at: 2 },
      { id: "native:uncertain", response: null, created_at: 2 },
    ]);
    expect(
      db
        .prepare("SELECT state FROM native_decisions WHERE id='uncertain'")
        .get(),
    ).toEqual({ state: "unknown" });
    const tip = () =>
      db
        .prepare(
          "SELECT last_event_id FROM change_watermark WHERE owner_id='owner'",
        )
        .get();
    const beforeRollback = tip();
    expect(() =>
      db
        .transaction(() => {
          db.prepare(
            "UPDATE personal_decisions SET response='{}' WHERE id='native:answered'",
          ).run();
          throw new Error("Rollback response and its invalidation together");
        })
        .immediate(),
    ).toThrow("Rollback response");
    expect(tip()).toEqual(beforeRollback);
    expect(
      db
        .prepare(
          "SELECT response FROM personal_decisions WHERE id='native:answered'",
        )
        .get(),
    ).toEqual({ response: null });
    db.prepare("DELETE FROM native_decisions WHERE id='answered'").run();
    expect(
      db
        .prepare("SELECT 1 FROM personal_decisions WHERE id='native:answered'")
        .get(),
    ).toBeUndefined();
    expect(
      db
        .prepare(
          "SELECT run_id,payload FROM events WHERE type='tombstone' AND subject_kind='collection' AND subject_id='decisions' ORDER BY id DESC LIMIT 1",
        )
        .get(),
    ).toMatchObject({
      run_id: null,
      payload: expect.stringContaining(
        '"removed":{"kind":"collection","id":"decisions"}',
      ),
    });
  } finally {
    db.close();
  }
});
