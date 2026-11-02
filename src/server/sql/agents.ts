import { FOLDER_PROJECT } from "./folders.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const ownerExistsStatement = statement(
  "SELECT 1 FROM agents WHERE owner_id=? AND id=?",
);
const ownerExistsRow = z.object({ "1": z.number() });
export function ownerExists(
  db: Database.Database,
  owner: string,
  agent: string,
) {
  const row = ownerExistsStatement(db).get(owner, agent);
  return row === undefined
    ? undefined
    : parseRecord(ownerExistsRow, row, "agents");
}

const existsOwnedStatement = statement(
  "SELECT 1 FROM agents WHERE id=? AND owner_id=?",
);
const existsOwnedRow = z.object({ "1": z.number() });
export function existsOwned(db: Database.Database, id: string, owner: string) {
  const row = existsOwnedStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(existsOwnedRow, row, "agents");
}

const insertStatement = statement(
  "INSERT INTO agents(id,owner_id,name,normalized_name,provider,connection_id,model,instructions,created_at,folder_id,effort) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
);
export function insert(
  db: Database.Database,
  id: string,
  owner: string,
  name: string,
  normalized: string,
  provider: string,
  connection: string,
  model: string,
  instructions: string,
  created: number,
  folder: string | null,
  effort: string | null,
) {
  return insertStatement(db).run(
    id,
    owner,
    name,
    normalized,
    provider,
    connection,
    model,
    instructions,
    created,
    folder,
    effort,
  );
}

const renameStatement = statement(
  "UPDATE agents SET name=?,normalized_name=? WHERE id=?",
);
export function rename(
  db: Database.Database,
  name: string,
  normalized: string,
  agent: string,
) {
  return renameStatement(db).run(name, normalized, agent);
}

const ownedStatement = statement(
  "SELECT * FROM agents WHERE id=? AND owner_id=?",
);
export function owned(db: Database.Database, id: string, owner: string) {
  const row = ownedStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.agents, row, "agents");
}

const retirementStatement = statement(
  "SELECT retired_at FROM agents WHERE id=? AND owner_id=?",
);
const retirementRow = QueryRecords.agents.pick({ retired_at: true });
export function retirement(
  db: Database.Database,
  agent: string | null,
  owner: string,
) {
  const row = retirementStatement(db).get(agent, owner);
  return row === undefined
    ? undefined
    : parseRecord(retirementRow, row, "agents");
}

const forOwnerStatement = statement(
  "SELECT * FROM agents WHERE owner_id=? ORDER BY created_at DESC",
);
const forOwnerRow = QueryRecords.agents;
export function forOwner(db: Database.Database, owner: string) {
  return forOwnerStatement(db)
    .all(owner)
    .map((row) => parseRecord(forOwnerRow, row, "agents"));
}

const retireStatement = statement(
  "UPDATE agents SET retired_at=? WHERE id=? AND owner_id=?",
);
export function retire(
  db: Database.Database,
  retired: number | null,
  id: string,
  owner: string,
) {
  return retireStatement(db).run(retired, id, owner);
}

const folderStatement = statement(
  "UPDATE agents SET folder_id=? WHERE id=? AND owner_id=?",
);
export function folder(
  db: Database.Database,
  folder: string | null,
  id: string,
  owner: string,
) {
  return folderStatement(db).run(folder, id, owner);
}

const instructionsStatement = statement(
  "UPDATE agents SET instructions=? WHERE id=?",
);
export function instructions(
  db: Database.Database,
  instructions: string,
  id: string,
) {
  return instructionsStatement(db).run(instructions, id);
}

const configureStatement = statement(
  "UPDATE agents SET connection_id=?,provider=?,model=?,effort=? WHERE id=?",
);
export function configure(
  db: Database.Database,
  connection: string,
  provider: string,
  model: string,
  effort: string | null,
  id: string,
) {
  return configureStatement(db).run(connection, provider, model, effort, id);
}

const projectCountsStatement = statement(
  `WITH RECURSIVE ${FOLDER_PROJECT} SELECT fp.project_id,count(*) n FROM agents a JOIN folder_project fp ON fp.id IS a.folder_id WHERE a.owner_id=@owner AND a.retired_at IS NULL GROUP BY fp.project_id`,
);
const projectCountsRow = z.object({ project_id: z.string(), n: z.number() });
export function projectCounts(db: Database.Database, owner: string) {
  return projectCountsStatement(db)
    .all({ owner })
    .map((row) => parseRecord(projectCountsRow, row, "agents"));
}
