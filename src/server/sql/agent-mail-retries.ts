import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const getStatement = statement(
  "SELECT * FROM agent_mail_retries WHERE owner_id=? AND key=?",
);
export function get(db: Database.Database, owner: string, key: string) {
  const row = getStatement(db).get(owner, key);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.agent_mail_retries, row, "agent_mail_retries");
}
const scheduleStatement =
  statement(`INSERT INTO agent_mail_retries(owner_id,key,mail_id,run_id,attempts,retry_at,delay_ms)
 VALUES(@owner_id,@key,@mail_id,@run_id,@attempts,@retry_at,@delay_ms)
 ON CONFLICT(owner_id,key) DO UPDATE SET attempts=excluded.attempts,retry_at=excluded.retry_at,delay_ms=excluded.delay_ms`);
export function schedule(
  db: Database.Database,
  row: typeof QueryRecords.agent_mail_retries._type,
) {
  return scheduleStatement(db).run(row);
}
const clearStatement = statement(
  "DELETE FROM agent_mail_retries WHERE owner_id=? AND key=?",
);
export function clear(db: Database.Database, owner: string, key: string) {
  return clearStatement(db).run(owner, key);
}
