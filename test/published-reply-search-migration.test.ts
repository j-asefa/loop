import { expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations } from "../src/server/migrations";

it.each(["server", "companion"])(
  "%s indexes existing and new published replies while leaving progress out of search",
  (profile) => {
    const directory = mkdtempSync(
      join(tmpdir(), "loop55-reply-search-migration-"),
    );
    const db = new Database(":memory:");
    try {
      db.pragma("foreign_keys=ON");
      const old = join(directory, "migrations");
      mkdirSync(old);
      for (const file of readdirSync("migrations").filter(
        (file) => file.endsWith(".sql") && Number(file.split("-")[0]) < 147,
      ))
        copyFileSync(join("migrations", file), join(old, file));
      applyMigrations(db, old);
      db.prepare("INSERT INTO deployment_profile VALUES(1,?)").run(profile);
      for (const owner of ["one", "two"]) {
        db.prepare(
          "INSERT INTO conversations(id,owner_id,title,created_at) VALUES(?,?,'Thread',1)",
        ).run(owner, owner);
        db.prepare(
          "INSERT INTO runs(id,owner_id,conversation_id,input,state,idempotency_key,created_at,updated_at) VALUES(?,?,?,'Task','running',?,1,1)",
        ).run(owner, owner, owner, owner);
        for (const [name, role, metadata] of [
          ["prompt", "user", "{}"],
          ["reply", "assistant", '{"progress":true}'],
          ["progress", "assistant", '{"progress":true}'],
        ])
          db.prepare(
            "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,?,?,?,1)",
          ).run(
            `${owner}-${name}`,
            owner,
            owner,
            owner,
            role,
            `${name} needle`,
            metadata,
          );
        db.prepare(
          "INSERT INTO run_steering(id,owner_id,run_id,message_id,idempotency_key,request,state,created_at) VALUES(?,?,?,?,?,'{}','delivered',1)",
        ).run(owner, owner, owner, `${owner}-prompt`, owner);
        db.prepare(
          "INSERT INTO steering_replies(message_id,owner_id,steering_id,created_at,archived_at) VALUES(?,?,?,1,?)",
        ).run(`${owner}-reply`, owner, owner, owner === "two" ? 2 : null);
      }
      const matches = () =>
        db
          .prepare(
            "SELECT d.id,d.owner_id FROM search_fts f JOIN search_documents d ON d.id=f.id WHERE search_fts MATCH 'reply' ORDER BY d.id",
          )
          .all();
      expect(matches()).toEqual([]);
      applyMigrations(db);
      const expected = [
        { id: "message:one-reply", owner_id: "one" },
        { id: "message:two-reply", owner_id: "two" },
      ];
      expect(matches()).toEqual(expected);
      applyMigrations(db);
      expect(matches()).toEqual(expected);
      expect(
        db
          .prepare("SELECT id FROM search_documents WHERE id LIKE '%progress'")
          .all(),
      ).toEqual([]);
      // Removing and restoring a publication updates FTS, with the original
      // message and another owner's reply preserved throughout.
      db.prepare(
        "DELETE FROM steering_replies WHERE message_id='one-reply'",
      ).run();
      expect(matches()).toEqual(expected.slice(1));
      db.prepare(
        "INSERT INTO steering_replies(message_id,owner_id,steering_id,created_at) VALUES('one-reply','one','one',3)",
      ).run();
      expect(matches()).toEqual(expected);
      db.prepare(
        "UPDATE messages SET content='Updated answer' WHERE id='one-reply'",
      ).run();
      expect(matches()).toEqual(expected.slice(1));
      expect(
        db
          .prepare("SELECT id FROM search_fts WHERE search_fts MATCH 'Updated'")
          .all(),
      ).toEqual([{ id: "message:one-reply" }]);
      db.prepare("DELETE FROM messages WHERE id='one-reply'").run();
      expect(
        db
          .prepare(
            "SELECT id FROM search_documents WHERE id='message:one-reply'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
