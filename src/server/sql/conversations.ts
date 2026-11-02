import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const existsOwnedStatement = statement(
  "SELECT 1 FROM conversations WHERE id=? AND owner_id=?",
);
const existsOwnedRow = z.object({ "1": z.number() });
export function existsOwned(db: Database.Database, id: string, owner: string) {
  const row = existsOwnedStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(existsOwnedRow, row, "conversations");
}

const ownedStatement = statement(
  "SELECT * FROM conversations WHERE id=? AND owner_id=?",
);
export function owned(db: Database.Database, id: string, owner: string) {
  const row = ownedStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.conversations, row, "conversations");
}

const insertTeamStatement = statement(
  "INSERT INTO conversations(id,owner_id,agent_id,title,created_at,team_id) VALUES(?,?,?,?,?,?)",
);
export function insertTeam(
  db: Database.Database,
  id: string,
  owner: string,
  agent: string,
  title: string,
  created: number,
  team: string | null,
) {
  return insertTeamStatement(db).run(id, owner, agent, title, created, team);
}

const pinExecutionStatement = statement(
  "UPDATE conversations SET execution_connection_id=COALESCE(execution_connection_id,?),project_id=COALESCE(project_id,?) WHERE id=?",
);
export function pinExecution(
  db: Database.Database,
  connection: string,
  project: string | null,
  conversation: string,
) {
  return pinExecutionStatement(db).run(connection, project, conversation);
}

const insertManagerStatement = statement(
  "INSERT INTO conversations(id,owner_id,agent_id,title,team_id,execution_connection_id,created_at) VALUES(?,?,?,?,?,?,?)",
);
export function insertManager(
  db: Database.Database,
  id: string,
  owner: string,
  agent: string,
  title: string,
  team: string,
  connection: string | null,
  created: number,
) {
  return insertManagerStatement(db).run(
    id,
    owner,
    agent,
    title,
    team,
    connection,
    created,
  );
}

const clearTeamStatement = statement(
  "UPDATE conversations SET team_id=NULL WHERE team_id=? AND owner_id=?",
);
export function clearTeam(db: Database.Database, team: string, owner: string) {
  return clearTeamStatement(db).run(team, owner);
}

const forAgentStatement = statement(
  "SELECT * FROM conversations WHERE owner_id=? AND agent_id=? ORDER BY created_at DESC LIMIT 100",
);
const forAgentRow = QueryRecords.conversations;
export function forAgent(db: Database.Database, owner: string, agent: string) {
  return forAgentStatement(db)
    .all(owner, agent)
    .map((row) => parseRecord(forAgentRow, row, "conversations"));
}
