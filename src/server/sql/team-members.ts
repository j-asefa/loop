import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const existsStatement = statement(
  "SELECT 1 FROM team_members WHERE team_id=? AND agent_id=?",
);
const existsRow = z.object({ "1": z.number() });
export function exists(
  db: Database.Database,
  team: string | undefined,
  agent: string,
) {
  const row = existsStatement(db).get(team, agent);
  return row === undefined
    ? undefined
    : parseRecord(existsRow, row, "team_members");
}

const activeInstructionsStatement = statement(
  "SELECT a.id,a.name,substr(a.instructions,1,1000) AS instructions FROM team_members m JOIN agents a ON a.id=m.agent_id WHERE m.team_id=? AND a.owner_id=? AND a.retired_at IS NULL",
);
const activeInstructionsRow = z.object({
  id: QueryRecords.agents.shape.id,
  name: QueryRecords.agents.shape.name,
  instructions: QueryRecords.agents.shape.instructions,
});
export function activeInstructions(
  db: Database.Database,
  team: string,
  owner: string,
) {
  return activeInstructionsStatement(db)
    .all(team, owner)
    .map((row) => parseRecord(activeInstructionsRow, row, "team_members"));
}

const agentsStatement = statement(
  "SELECT agent_id FROM team_members WHERE team_id=?",
);
const agentsRow = QueryRecords.team_members.pick({ agent_id: true });
export function agents(db: Database.Database, team: string) {
  return agentsStatement(db)
    .all(team)
    .map((row) => parseRecord(agentsRow, row, "team_members"));
}

const insertStatement = statement("INSERT INTO team_members VALUES(?,?)");
export function insert(db: Database.Database, team: string, agent: string) {
  return insertStatement(db).run(team, agent);
}

const activeCountStatement = statement(
  "SELECT count(*) n FROM team_members m\n               JOIN agents a ON a.id=m.agent_id\n               WHERE m.team_id=? AND a.retired_at IS NULL",
);
const activeCountRow = z.object({ n: z.number() });
export function activeCount(db: Database.Database, team: string) {
  const row = activeCountStatement(db).get(team);
  return row === undefined
    ? undefined
    : parseRecord(activeCountRow, row, "team_members");
}

const addStatement = statement(
  "INSERT INTO team_members(team_id,agent_id) VALUES(?,?)",
);
export function add(db: Database.Database, team: string, agent: string) {
  return addStatement(db).run(team, agent);
}
