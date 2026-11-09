import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const removeStatement = statement(
  "DELETE FROM card_token_reads WHERE token_id=? AND owner_id=?",
);
export function remove(db: Database.Database, token: string, owner: string) {
  return removeStatement(db).run(token, owner);
}

const knownPageStatement = statement(
  "SELECT card_id FROM card_token_reads WHERE token_id=? AND owner_id=? AND card_id IN (SELECT value FROM json_each(?))",
);
const knownPageRow = QueryRecords.card_token_reads.pick({ card_id: true });
export function knownPage(
  db: Database.Database,
  token: string,
  owner: string,
  ids: string,
) {
  return knownPageStatement(db)
    .all(token, owner, ids)
    .map((row) => parseRecord(knownPageRow, row, "card_token_reads"));
}

const insertActiveStatement = statement(
  "INSERT OR IGNORE INTO card_token_reads(token_id,owner_id,card_id) SELECT @token,@owner,@card WHERE EXISTS(SELECT 1 FROM card_tokens WHERE id=@token AND owner_id=@owner AND revoked_at IS NULL)",
);
export function insertActive(
  db: Database.Database,
  token: string,
  owner: string,
  card: string,
) {
  return insertActiveStatement(db).run({ token, owner, card });
}
const knownStatement = statement(
  "SELECT 1 FROM card_token_reads WHERE token_id=? AND owner_id=? AND card_id=?",
);
export function known(
  db: Database.Database,
  token: string,
  owner: string,
  card: string,
) {
  const row = knownStatement(db).get(token, owner, card);
  return row === undefined
    ? undefined
    : parseRecord(z.object({ "1": z.number() }), row, "card_token_reads");
}
