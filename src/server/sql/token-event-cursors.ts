import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const currentStatement = statement(
  "SELECT connection_id FROM token_event_cursors WHERE token_id=? AND owner_id=?",
);
const currentRow = QueryRecords.token_event_cursors.pick({
  connection_id: true,
});
export function current(db: Database.Database, token: string, owner: string) {
  const row = currentStatement(db).get(token, owner);
  return row === undefined
    ? undefined
    : parseRecord(currentRow, row, "token_event_cursors");
}

const confirmStatement = statement(
  "UPDATE token_event_cursors SET epoch=?,cursor=CASE WHEN ? THEN ? WHEN epoch=? AND cursor<=? THEN max(cursor,?) ELSE ? END\n        WHERE token_id=? AND owner_id=? AND connection_id=?",
);
export function confirm(
  db: Database.Database,
  epoch: string,
  reset: number,
  resetCursor: number,
  expectedEpoch: string,
  lastEvent: number,
  advanceCursor: number,
  fallbackCursor: number,
  token: string,
  owner: string,
  connection: string,
) {
  return confirmStatement(db).run(
    epoch,
    reset,
    resetCursor,
    expectedEpoch,
    lastEvent,
    advanceCursor,
    fallbackCursor,
    token,
    owner,
    connection,
  );
}

const connectStatement = statement(
  "INSERT INTO token_event_cursors(token_id,owner_id,connection_id) VALUES(?,?,?)\n                    ON CONFLICT(token_id) DO UPDATE SET connection_id=excluded.connection_id WHERE owner_id=excluded.owner_id\n                    RETURNING epoch,cursor,connection_id",
);
const connectRow = QueryRecords.token_event_cursors.pick({
  epoch: true,
  cursor: true,
  connection_id: true,
});
export function connect(
  db: Database.Database,
  token: string,
  owner: string,
  connection: string,
) {
  const row = connectStatement(db).get(token, owner, connection);
  return row === undefined
    ? undefined
    : parseRecord(connectRow, row, "token_event_cursors");
}
