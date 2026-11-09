import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement, statementVariants } from "./statement.js";

const recordStatement = statement(
  "SELECT record FROM agent_activities WHERE owner_id=? AND scope=? AND activity_key=?",
);
const recordRow = QueryRecords.agent_activities.pick({ record: true });
export function record(
  db: Database.Database,
  owner: string,
  scope: string | null,
  key: string,
) {
  const row = recordStatement(db).get(owner, scope, key);
  return row === undefined
    ? undefined
    : parseRecord(recordRow, row, "agent_activities");
}

const maxSequenceStatement = statement(
  "SELECT coalesce(max(sequence),0) n FROM agent_activities WHERE owner_id=?",
);
const maxSequenceRow = z.object({ n: z.number() });
export function maxSequence(db: Database.Database, owner: string) {
  const row = maxSequenceStatement(db).get(owner);
  return row === undefined
    ? undefined
    : parseRecord(maxSequenceRow, row, "agent_activities");
}

const upsertStatement = statement(
  "INSERT INTO agent_activities(owner_id,scope,activity_key,conversation_id,run_id,kind,record,sequence,created_at,updated_at)\n    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,scope,activity_key) DO UPDATE SET\n    record=excluded.record,sequence=excluded.sequence,updated_at=excluded.updated_at",
);
export function upsert(
  db: Database.Database,
  owner: string,
  scope: string | null,
  key: string,
  conversation: string | null,
  run: string | null,
  kind: string,
  record: string,
  sequence: number,
  created: number,
  updated: number,
) {
  return upsertStatement(db).run(
    owner,
    scope,
    key,
    conversation,
    run,
    kind,
    record,
    sequence,
    created,
    updated,
  );
}

const recentKindStatement = statement(
  "SELECT * FROM agent_activities WHERE owner_id=? AND scope=? AND kind=?\n           ORDER BY sequence DESC LIMIT 16",
);
const recentKindRow = QueryRecords.agent_activities;
export function recentKind(
  db: Database.Database,
  owner: string,
  scope: string,
  kind: string,
) {
  return recentKindStatement(db)
    .all(owner, scope, kind)
    .map((row) => parseRecord(recentKindRow, row, "agent_activities"));
}

const controlUpdatesStatement = statement(
  "SELECT * FROM agent_activities WHERE owner_id=? AND scope=?\n          AND kind IN ('settings','commands','capabilities','file_change') AND sequence>?\n          ORDER BY sequence LIMIT 501",
);
const controlUpdatesRow = QueryRecords.agent_activities;
export function controlUpdates(
  db: Database.Database,
  owner: string,
  scope: string,
  after: number,
) {
  return controlUpdatesStatement(db)
    .all(owner, scope, after)
    .map((row) => parseRecord(controlUpdatesRow, row, "agent_activities"));
}

const cursorStatement = statement(
  "SELECT max(sequence) cursor FROM agent_activities WHERE owner_id=? AND scope=?",
);
const cursorRow = z.object({ cursor: z.number().nullable() });
export function cursor(db: Database.Database, owner: string, scope: string) {
  const row = cursorStatement(db).get(owner, scope);
  return row === undefined
    ? undefined
    : parseRecord(cursorRow, row, "agent_activities");
}

const beforeStatement = statement(
  "SELECT * FROM agent_activities\n      WHERE owner_id=? AND scope=? AND sequence<? ORDER BY sequence DESC LIMIT 101",
);
const beforeRow = QueryRecords.agent_activities;
export function before(
  db: Database.Database,
  owner: string,
  scope: string,
  before: number,
) {
  return beforeStatement(db)
    .all(owner, scope, before)
    .map((row) => parseRecord(beforeRow, row, "agent_activities"));
}

const hasEarlierToolsStatement = statement(
  "SELECT 1 FROM agent_activities WHERE owner_id=? AND scope=?\n      AND kind IN ('tool','output','plan') AND sequence<? LIMIT 1",
);
const hasEarlierToolsRow = z.object({ "1": z.number() });
export function hasEarlierTools(
  db: Database.Database,
  owner: string,
  scope: string,
  before: number,
) {
  const row = hasEarlierToolsStatement(db).get(owner, scope, before);
  return row === undefined
    ? undefined
    : parseRecord(hasEarlierToolsRow, row, "agent_activities");
}

const updatesStatement = statement(
  "SELECT * FROM agent_activities WHERE owner_id=@owner AND scope=@scope AND sequence>@after\n      AND (@run IS NULL OR run_id IS NULL OR run_id=@run) ORDER BY sequence LIMIT 501",
);
const updatesRow = QueryRecords.agent_activities;
export function updates(
  db: Database.Database,
  owner: string,
  scope: string,
  after: number,
  run: string | null,
) {
  return updatesStatement(db)
    .all({ owner, scope, after, run })
    .map((row) => parseRecord(updatesRow, row, "agent_activities"));
}

const fileUpdatesStatement = statementVariants();
export function fileUpdates(
  db: Database.Database,
  owner: string,
  conversation: string,
  runs: readonly string[],
  after: number,
) {
  return fileUpdatesStatement(
    `SELECT * FROM agent_activities WHERE owner_id=? AND scope=?
      AND run_id IN (${runs.map(() => "?").join(",")}) AND kind='file_change' AND sequence>?
      ORDER BY sequence LIMIT 501`,
    db,
  )
    .all(owner, conversation, ...runs, after)
    .map((row) =>
      parseRecord(QueryRecords.agent_activities, row, "agent_activities"),
    );
}
