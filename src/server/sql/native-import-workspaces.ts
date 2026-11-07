import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const destinationStatement = statement(
  "SELECT harness,project,source FROM native_import_workspaces WHERE owner_id=? AND kind=? AND import_key=? LIMIT 1",
);
const destinationRow = QueryRecords.native_import_workspaces.pick({
  harness: true,
  project: true,
  source: true,
});
export function destination(
  db: Database.Database,
  owner: string,
  kind: string,
  key: string,
) {
  const row = destinationStatement(db).get(owner, kind, key);
  return row === undefined
    ? undefined
    : parseRecord(destinationRow, row, "native_import_workspaces");
}

const insertStatement = statement(
  "INSERT OR IGNORE INTO native_import_workspaces(owner_id,kind,import_key,source,harness,project,agent_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
);
export function insert(
  db: Database.Database,
  owner: string,
  kind: string,
  key: string,
  source: string,
  harness: string,
  project: string,
  agent: string,
  created: number,
) {
  return insertStatement(db).run(
    owner,
    kind,
    key,
    source,
    harness,
    project,
    agent,
    created,
  );
}

const pendingStatement = statement(
  "SELECT agent_id,workspace FROM native_import_workspaces WHERE owner_id=? AND kind=? AND import_key=? AND imported_at IS NULL",
);
const pendingRow = QueryRecords.native_import_workspaces.pick({
  agent_id: true,
  workspace: true,
});
export function pending(
  db: Database.Database,
  owner: string,
  kind: string,
  key: string,
) {
  const row = pendingStatement(db).get(owner, kind, key);
  return row === undefined
    ? undefined
    : parseRecord(pendingRow, row, "native_import_workspaces");
}

const setWorkspaceStatement = statement(
  "UPDATE native_import_workspaces SET workspace=? WHERE owner_id=? AND agent_id=? AND workspace IS ? AND imported_at IS NULL",
);
export function setWorkspace(
  db: Database.Database,
  workspace: string,
  owner: string,
  agent: string,
  previous: string | null,
) {
  return setWorkspaceStatement(db).run(workspace, owner, agent, previous);
}

const completeStatement = statement(
  "UPDATE native_import_workspaces SET imported_at=? WHERE owner_id=? AND agent_id=? AND project=? AND harness=? AND workspace=? AND imported_at IS NULL",
);
export function complete(
  db: Database.Database,
  time: number,
  owner: string,
  agent: string,
  project: string,
  harness: string,
  workspace: string,
) {
  return completeStatement(db).run(
    time,
    owner,
    agent,
    project,
    harness,
    workspace,
  );
}
