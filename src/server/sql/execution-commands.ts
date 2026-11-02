import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const resultSizesStatement = statement(
  "SELECT command_id,length(CAST(result AS BLOB)) bytes FROM execution_commands WHERE owner_id=? AND result IS NOT NULL ORDER BY (command_id=?) DESC,updated_at DESC,command_id DESC",
);
const resultSizesRow = z.object({ command_id: z.string(), bytes: z.number() });
export function resultSizes(
  db: Database.Database,
  owner: string,
  current: string,
) {
  return resultSizesStatement(db)
    .all(owner, current)
    .map((row) => parseRecord(resultSizesRow, row, "execution_commands"));
}

const receiptStatement = statement(
  "SELECT method,digest,generation,state,result FROM execution_commands WHERE owner_id=? AND command_id=?",
);
const receiptRow = QueryRecords.execution_commands.pick({
  method: true,
  digest: true,
  generation: true,
  state: true,
  result: true,
});
export function receipt(db: Database.Database, owner: string, command: string) {
  const row = receiptStatement(db).get(owner, command);
  return row === undefined
    ? undefined
    : parseRecord(receiptRow, row, "execution_commands");
}

const startStatement = statement(
  "INSERT INTO execution_commands(owner_id,command_id,method,digest,generation,state,created_at,updated_at) VALUES(?,?,?,?,?,'started',?,?)",
);
export function start(
  db: Database.Database,
  owner: string,
  command: string,
  method: string,
  digest: string,
  generation: string,
  created: number,
  updated: number,
) {
  return startStatement(db).run(
    owner,
    command,
    method,
    digest,
    generation,
    created,
    updated,
  );
}

const completeStatement = statement(
  "UPDATE execution_commands SET state='completed',result=?,updated_at=? WHERE owner_id=? AND command_id=? AND generation=? AND state='started'",
);
export function complete(
  db: Database.Database,
  result: string | null,
  time: number,
  owner: string,
  command: string,
  generation: string,
) {
  return completeStatement(db).run(result, time, owner, command, generation);
}

const refusedStatement = statement(
  "DELETE FROM execution_commands WHERE owner_id=? AND command_id=? AND generation=? AND state='started'",
);
export function refused(
  db: Database.Database,
  owner: string,
  command: string,
  generation: string,
) {
  return refusedStatement(db).run(owner, command, generation);
}

const unknownStatement = statement(
  "UPDATE execution_commands SET state='unknown',updated_at=? WHERE owner_id=? AND command_id=? AND generation=? AND state='started'",
);
export function unknown(
  db: Database.Database,
  time: number,
  owner: string,
  command: string,
  generation: string,
) {
  return unknownStatement(db).run(time, owner, command, generation);
}

const compactStatement = statement(
  "UPDATE execution_commands SET result=NULL WHERE owner_id=? AND command_id=? AND state='completed'",
);
export function compact(db: Database.Database, owner: string, command: string) {
  return compactStatement(db).run(owner, command);
}
