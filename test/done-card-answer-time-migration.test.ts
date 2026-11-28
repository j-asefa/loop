import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations } from "../src/server/migrations.js";
import { projectFeed } from "../src/server/feed-projector.js";
import { sealSeededHistory } from "./helpers/published-history";
import { installFixtureProjection } from "./helpers/projected-writer";
import { applyMigrationsThrough } from "./helpers/migrations.js";

const OWNER = "owner-answer-time";
const SENT = 1_000;
const PLACEHOLDER = 1_002;
const FINISHED = 9_000;

it("re-projects stored Done cards with the time their answer was published", () => {
  const directory = mkdtempSync(join(tmpdir(), "loop-answer-time-migration-"));
  const db = new Database(join(directory, "loop.db"));
  try {
    db.pragma("foreign_keys=ON");
    applyMigrationsThrough(db, 167);
    installFixtureProjection(db);
    db.transaction(() => {
      db.prepare(
        "INSERT INTO conversations(id,owner_id,title,created_at) VALUES('c',?,'Long task',?)",
      ).run(OWNER, SENT);
      db.prepare(
        "INSERT INTO runs(id,owner_id,conversation_id,input,state,idempotency_key,created_at,updated_at) VALUES('r',?,'c','Do the long task','completed','r',?,?)",
      ).run(OWNER, SENT, FINISHED);
      db.prepare(
        "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES('u',?,'c','r','user','Do the long task',?)",
      ).run(OWNER, SENT);
      // As native harnesses store it: the answer row from the turn's start.
      db.prepare(
        "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at,revision) VALUES('a',?,'c','r','assistant','Finished answer',?,6)",
      ).run(OWNER, PLACEHOLDER);
    }).immediate();
    sealSeededHistory(db);

    const result = () =>
      db
        .prepare(
          "SELECT id,kind,sealed,created_at,message_id,content_digest FROM results WHERE owner_id=?",
        )
        .all(OWNER);
    const sealed = result();
    expect(sealed).toEqual([
      expect.objectContaining({
        id: "run:r",
        kind: "run_answer",
        sealed: 1,
        created_at: FINISHED,
        message_id: "a",
      }),
    ]);
    // Released builds stored the answer row's time in the card payload.
    db.prepare(
      "UPDATE feed_cards SET payload=json_set(payload,'$.row.message_created_at',?) WHERE owner_id=? AND card_key='run:r'",
    ).run(PLACEHOLDER, OWNER);
    const stored = () =>
      db
        .prepare(
          "SELECT card_key,sort_at,json_extract(payload,'$.row.message_created_at') message_created_at,json_extract(payload,'$.row.message_content') content FROM feed_cards WHERE owner_id=? AND card_key='run:r'",
        )
        .get(OWNER) as {
        card_key: string;
        sort_at: number;
        message_created_at: number;
        content: string;
      };
    expect(stored()).toMatchObject({
      sort_at: FINISHED,
      message_created_at: PLACEHOLDER,
    });
    const sources = () => [
      db.prepare("SELECT * FROM messages ORDER BY id").all(),
      db.prepare("SELECT * FROM runs ORDER BY id").all(),
    ];
    const before = sources();

    db.transaction(() => {
      applyMigrations(db);
      projectFeed(db, () => {});
    }).immediate();

    expect(
      db
        .prepare("SELECT 1 FROM schema_migrations WHERE name=?")
        .get("done-card-answer-time"),
    ).toBeTruthy();
    expect(stored()).toEqual({
      card_key: "run:r",
      sort_at: FINISHED,
      message_created_at: FINISHED,
      content: "Finished answer",
    });
    // Only the projection changes: the answer, its run and its Result keep
    // their content, identities and times.
    expect(sources()).toEqual(before);
    expect(result()).toEqual(sealed);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
