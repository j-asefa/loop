import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const versionStatement = statement(
  "SELECT version FROM done_card_unread_versions WHERE owner_id=? AND conversation_id=? AND card_key=?",
);
const versionRow = QueryRecords.done_card_unread_versions.pick({
  version: true,
});
export function version(
  db: Database.Database,
  owner: string,
  conversation: string,
  key: string,
) {
  const row = versionStatement(db).get(owner, conversation, key);
  return row === undefined
    ? undefined
    : parseRecord(versionRow, row, "done_card_unread_versions");
}

const advanceStatement = statement(
  "INSERT INTO done_card_unread_versions(owner_id,conversation_id,card_key,version) VALUES(?,?,?,1)\n    ON CONFLICT(owner_id,conversation_id,card_key) DO UPDATE SET version=version+1 RETURNING version",
);
const advanceRow = QueryRecords.done_card_unread_versions.pick({
  version: true,
});
export function advance(
  db: Database.Database,
  owner: string,
  conversation: string,
  key: string,
) {
  const row = advanceStatement(db).get(owner, conversation, key);
  return row === undefined
    ? undefined
    : parseRecord(advanceRow, row, "done_card_unread_versions");
}
