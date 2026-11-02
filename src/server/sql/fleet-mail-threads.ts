import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const getStatement = statement(
  "SELECT * FROM fleet_mail_threads WHERE owner_id=? AND thread_id=?",
);
const getRow = QueryRecords.fleet_mail_threads;
export function get(db: Database.Database, owner: string, thread: string) {
  const row = getStatement(db).get(owner, thread);
  return row === undefined
    ? undefined
    : parseRecord(getRow, row, "fleet_mail_threads");
}

const wireStatement = statement(
  "SELECT * FROM fleet_mail_threads WHERE owner_id=? AND origin_id=? AND wire_thread_id=?",
);
const wireRow = QueryRecords.fleet_mail_threads;
export function wire(
  db: Database.Database,
  owner: string,
  origin: string,
  thread: string,
) {
  const row = wireStatement(db).get(owner, origin, thread);
  return row === undefined
    ? undefined
    : parseRecord(wireRow, row, "fleet_mail_threads");
}

const renameStatement = statement(
  "UPDATE fleet_mail_threads SET remote_name=? WHERE owner_id=? AND thread_id=?",
);
export function rename(
  db: Database.Database,
  name: string,
  owner: string,
  thread: string,
) {
  return renameStatement(db).run(name, owner, thread);
}

const insertStatement = statement(
  "INSERT INTO fleet_mail_threads\n        (thread_id,owner_id,origin_id,wire_thread_id,local_agent_id,peer_id,remote_agent_id,remote_name,fleet_id,local_grant_id,peer_grant_id)\n        VALUES(@thread_id,@owner_id,@origin_id,@wire_thread_id,@local_agent_id,@peer_id,@remote_agent_id,@remote_name,@fleet_id,@local_grant_id,@peer_grant_id)",
);
export function insert(
  db: Database.Database,
  binding: z.infer<typeof QueryRecords.fleet_mail_threads>,
) {
  return insertStatement(db).run(binding);
}

const remoteNameStatement = statement(
  "SELECT remote_name FROM fleet_mail_threads WHERE owner_id=? AND thread_id=? AND peer_id=? AND remote_agent_id=?",
);
const remoteNameRow = QueryRecords.fleet_mail_threads.pick({
  remote_name: true,
});
export function remoteName(
  db: Database.Database,
  owner: string,
  thread: string,
  peer: string,
  agent: string,
) {
  const row = remoteNameStatement(db).get(owner, thread, peer, agent);
  return row === undefined
    ? undefined
    : parseRecord(remoteNameRow, row, "fleet_mail_threads");
}

const existsStatement = statement(
  "SELECT 1 FROM fleet_mail_threads WHERE owner_id=? AND thread_id=?",
);
const existsRow = z.object({ "1": z.number() });
export function exists(db: Database.Database, owner: string, thread: string) {
  const row = existsStatement(db).get(owner, thread);
  return row === undefined
    ? undefined
    : parseRecord(existsRow, row, "fleet_mail_threads");
}
