import { ACTIVE_RUN_STATES_SQL } from "../../shared/run-state.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const dueCountStatement = statement(
  "SELECT count(*) n FROM later_items WHERE owner_id=? AND surfaced_at IS NOT NULL AND done_at IS NULL",
);
const dueCountRow = z.object({ n: z.number() });
export function dueCount(db: Database.Database, owner: string) {
  const row = dueCountStatement(db).get(owner);
  return row === undefined
    ? undefined
    : parseRecord(dueCountRow, row, "later_items");
}

const openIdStatement = statement(
  "SELECT id FROM later_items WHERE owner_id=? AND kind=? AND target_id=? AND done_at IS NULL",
);
const openIdRow = QueryRecords.later_items.pick({ id: true });
export function openId(
  db: Database.Database,
  owner: string,
  kind: string,
  target: string,
) {
  const row = openIdStatement(db).get(owner, kind, target);
  return row === undefined
    ? undefined
    : parseRecord(openIdRow, row, "later_items");
}

const finishTargetStatement = statement(
  "UPDATE later_items SET done_at=? WHERE owner_id=? AND kind=? AND target_id=? AND done_at IS NULL",
);
export function finishTarget(
  db: Database.Database,
  time: number,
  owner: string,
  kind: string,
  target: string,
) {
  return finishTargetStatement(db).run(time, owner, kind, target);
}

const insertStatement = statement(
  "INSERT INTO later_items(id,owner_id,kind,target_id,condition,due_at,project_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
);
export function insert(
  db: Database.Database,
  id: string,
  owner: string,
  kind: string,
  target: string,
  condition: string,
  due: number | null | undefined,
  project: string | null | undefined,
  created: number,
) {
  return insertStatement(db).run(
    id,
    owner,
    kind,
    target,
    condition,
    due,
    project,
    created,
  );
}

const snoozeStatement = statement(
  "UPDATE later_items SET condition=?,due_at=?,project_id=?,surfaced_at=NULL,snoozes=snoozes+1 WHERE id=? AND owner_id=? AND done_at IS NULL",
);
export function snooze(
  db: Database.Database,
  condition: string,
  due: number | null | undefined,
  project: string | null | undefined,
  id: string,
  owner: string,
) {
  return snoozeStatement(db).run(condition, due, project, id, owner);
}

const openExistsStatement = statement(
  "SELECT 1 FROM later_items WHERE owner_id=? AND kind=? AND target_id=? AND done_at IS NULL",
);
const openExistsRow = z.object({ "1": z.number() });
export function openExists(
  db: Database.Database,
  owner: string,
  kind: string,
  target: string,
) {
  const row = openExistsStatement(db).get(owner, kind, target);
  return row === undefined
    ? undefined
    : parseRecord(openExistsRow, row, "later_items");
}

const restoreStatement = statement(
  "UPDATE later_items SET done_at=NULL WHERE id=? AND owner_id=?",
);
export function restore(db: Database.Database, id: string, owner: string) {
  return restoreStatement(db).run(id, owner);
}

const ownedStatement = statement(
  "SELECT * FROM later_items WHERE id=? AND owner_id=?",
);

export function owned(db: Database.Database, id: string, owner: string) {
  const row = ownedStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.later_items, row, "later_items");
}

const openStatement = statement(
  "SELECT * FROM later_items WHERE owner_id=? AND done_at IS NULL ORDER BY COALESCE(surfaced_at,due_at,created_at),created_at LIMIT 400",
);

export function open(db: Database.Database, owner: string) {
  return openStatement(db)
    .all(owner)
    .map((row) => parseRecord(QueryRecords.later_items, row, "later_items"));
}

const finishStatement = statement(
  "UPDATE later_items SET done_at=? WHERE id=? AND owner_id=? AND done_at IS NULL",
);
export function finish(
  db: Database.Database,
  time: number,
  id: string,
  owner: string,
) {
  return finishStatement(db).run(time, id, owner);
}

const projectOpenedStatement = statement(
  "UPDATE later_items SET surfaced_at=? WHERE owner_id=? AND condition='project_open' AND project_id=? AND surfaced_at IS NULL AND done_at IS NULL",
);
export function projectOpened(
  db: Database.Database,
  time: number,
  owner: string,
  project: string,
) {
  return projectOpenedStatement(db).run(time, owner, project);
}

const surfaceStatement = statement(
  "UPDATE later_items SET surfaced_at=? WHERE id=? AND surfaced_at IS NULL AND done_at IS NULL",
);
export function surface(db: Database.Database, time: number, id: string) {
  return surfaceStatement(db).run(time, id);
}

const dueStatement =
  statement(`SELECT l.* FROM later_items l WHERE l.done_at IS NULL AND l.surfaced_at IS NULL AND (
          (l.condition='time' AND l.due_at<=@now) OR
          (l.condition='run_finished' AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.owner_id=l.owner_id AND r.state IN ${ACTIVE_RUN_STATES_SQL}
            AND r.conversation_id=(CASE l.kind
              WHEN 'conversation' THEN l.target_id
              WHEN 'message' THEN (SELECT m.conversation_id FROM messages m WHERE m.id=l.target_id AND m.owner_id=l.owner_id)
              ELSE (SELECT COALESCE(a.conversation_id,(SELECT ar.conversation_id FROM runs ar WHERE ar.id=a.run_id)) FROM artifacts a WHERE a.id=l.target_id AND a.owner_id=l.owner_id) END))))
          ORDER BY l.created_at LIMIT 100`);

export function due(db: Database.Database, params: { now: number }) {
  return dueStatement(db)
    .all(params)
    .map((row) => parseRecord(QueryRecords.later_items, row, "later-items"));
}
