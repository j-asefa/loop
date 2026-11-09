import type Database from "better-sqlite3";
import { z } from "zod";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";
const revisionStatement = statement(
  "SELECT COALESCE(max(revision),0) revision FROM done_card_revisions WHERE owner_id=?",
);
const revisionRow = z.object({ revision: z.number() });
export function revision(db: Database.Database, owner: string) {
  return parseRecord(
    revisionRow,
    revisionStatement(db).get(owner),
    "done_card_revisions",
  );
}

const cardChangesStatement =
  statement(`SELECT revision,entity,object_id FROM done_card_revisions
    WHERE owner_id=? AND revision>? AND revision<=? ORDER BY revision LIMIT ?`);
const cardChangesRow = z.object({
  revision: z.number(),
  entity: z.string(),
  object_id: z.string(),
});
export function cardChanges(
  db: Database.Database,
  owner: string,
  after: number,
  revision: number,
  limit: number,
) {
  return cardChangesStatement(db)
    .all(owner, after, revision, limit)
    .map((row) => parseRecord(cardChangesRow, row, "done_card_revisions"));
}
