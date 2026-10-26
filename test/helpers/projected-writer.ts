import type Database from "better-sqlite3";
import { installProjectionBoundary } from "../../src/server/projected-database.js";
import { projectFeed } from "../../src/server/feed-projector.js";

/** Give an independent fixture connection the production worker's commit boundary. */
export function installFixtureProjection(db: Database.Database) {
  installProjectionBoundary(db, () =>
    projectFeed(db, (owner, subject, type, payload) =>
      db
        .prepare(
          "INSERT INTO events(owner_id,run_id,type,payload,created_at,subject_kind,subject_id) VALUES(?,NULL,?,?,?,?,?)",
        )
        .run(
          owner,
          type,
          JSON.stringify(payload),
          Date.now(),
          subject.kind,
          subject.id,
        ),
    ),
  );
}
