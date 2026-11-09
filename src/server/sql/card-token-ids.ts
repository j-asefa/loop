import type Database from "better-sqlite3";
import { z } from "zod";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const existsStatement = statement("SELECT 1 FROM card_token_ids WHERE id=?");
const existsRow = z.object({ "1": z.number() });
export function exists(db: Database.Database, id: string) {
  const row = existsStatement(db).get(id);
  return row === undefined
    ? undefined
    : parseRecord(existsRow, row, "card_token_ids");
}

const digestExistsStatement = statement(
  "SELECT 1 FROM card_token_ids WHERE digest=@digest UNION ALL SELECT 1 FROM card_tokens WHERE digest=@digest LIMIT 1",
);
const digestExistsRow = z.object({ "1": z.number() });
export function digestExists(db: Database.Database, digest: string) {
  const row = digestExistsStatement(db).get({ digest });
  return row === undefined
    ? undefined
    : parseRecord(digestExistsRow, row, "card_token_ids");
}

const insertStatement = statement("INSERT INTO card_token_ids VALUES(?,?,?)");
export function insert(
  db: Database.Database,
  id: string,
  owner: string,
  digest: string,
) {
  return insertStatement(db).run(id, owner, digest);
}
