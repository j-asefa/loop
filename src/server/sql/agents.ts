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
  "INSERT INTO agents(id,owner_id,name,normalized_name,provider,connection_id,model,instructions,created_at,folder_id,effort) VALUES(@id,@owner,@name,@name,@provider,@connection,@model,@instructions,@created,@folder,@effort)",
);
export function insert(
  db: Database.Database,
  id: string,
  owner: string,
  name: string,
  provider: string,
  connection: string,
  model: string,
  instructions: string,
  created: number,
  folder: string | null,
  effort: string | null,
) {
  return insertStatement(db).run({
    id,
    owner,
    name,
    provider,
    connection,
    model,
    instructions,
    created,
    folder,
    effort,
  });
}

const renameStatement = statement(
  "UPDATE agents SET name=@name,normalized_name=@name WHERE id=@agent",
);
export function rename(db: Database.Database, name: string, agent: string) {
  return renameStatement(db).run({ name, agent });
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

export function forOwner(db: Database.Database, owner: string) {
  return forOwnerStatement(db)
    .all(owner)
    .map((row) => parseRecord(QueryRecords.agents, row, "agents"));
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

const routingSuggestionStatement = statement(
  "SELECT a.* FROM agents a JOIN connections c ON c.id=a.connection_id AND c.owner_id=a.owner_id WHERE a.owner_id=@owner AND a.retired_at IS NULL AND c.status='connected' ORDER BY COALESCE((SELECT max(r.created_at) FROM runs r WHERE r.agent_id=a.id AND (@project IS NULL OR json_extract(r.payload,'$.folderId')=@project)),0) DESC,a.created_at DESC LIMIT 1",
);

export function routingSuggestion(
  db: Database.Database,
  owner: string,
  project: string | null,
) {
  const row = routingSuggestionStatement(db).get({ owner, project });
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.agents, row, "agents");
}

const insertImportedStatement = statement(
  "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,instructions,origin,created_at) VALUES(@id,@owner,@name,@name,@provider,'Imported history','','import',@created)",
);
export function insertImported(
  db: Database.Database,
  id: string,
  owner: string,
  name: string,
  provider: string,
  created: number,
) {
  return insertImportedStatement(db).run({
    id,
    owner,
    name,
    provider,
    created,
  });
}

const bindNativeHarnessStatement = statement(
  "UPDATE agents SET connection_id=? WHERE connection_id IS NULL AND id IN (SELECT agent_id FROM conversations c JOIN companion_sessions n ON n.conversation_id=c.id WHERE n.harness=?)",
);
export function bindNativeHarness(
  db: Database.Database,
  connection: string,
  harness: string,
) {
  return bindNativeHarnessStatement(db).run(connection, harness);
}

const connectionModelsStatement = statement(
  "SELECT name,model FROM agents WHERE owner_id=? AND connection_id=? ORDER BY name",
);
const connectionModelsRow = QueryRecords.agents.pick({
  name: true,
  model: true,
});
export function connectionModels(
  db: Database.Database,
  owner: string,
  connection: string,
) {
  return connectionModelsStatement(db)
    .all(owner, connection)
    .map((row) => parseRecord(connectionModelsRow, row, "agents"));
}

const insertNativeImportStatement = statement(
  "INSERT INTO agents(id,owner_id,name,normalized_name,provider,connection_id,model,instructions,created_at,folder_id) VALUES(@id,@owner,@name,@name,@provider,@connection,@model,'',@created,@folder)",
);
export function insertNativeImport(
  db: Database.Database,
  id: string,
  owner: string,
  name: string,
  provider: string,
  connection: string | null,
  model: string,
  created: number,
  folder: string,
) {
  return insertNativeImportStatement(db).run({
    id,
    owner,
    name,
    provider,
    connection,
    model,
    created,
    folder,
  });
}

const mailTeamMembersStatement = statement(
  "SELECT id,name,connection_id FROM agents WHERE owner_id=@owner AND retired_at IS NULL AND (id=@manager OR id IN (SELECT agent_id FROM team_members WHERE team_id=@team)) ORDER BY id=@manager DESC,name",
);
const mailTeamMembersRow = QueryRecords.agents.pick({
  id: true,
  name: true,
  connection_id: true,
});
export function mailTeamMembers(
  db: Database.Database,
  owner: string,
  manager: string,
  team: string,
) {
  return mailTeamMembersStatement(db)
    .all({ owner, manager, team })
    .map((row) => parseRecord(mailTeamMembersRow, row, "agents"));
}

const mailDirectoryStatement = statement(
  "SELECT * FROM agents WHERE owner_id=@owner AND retired_at IS NULL AND id<>@self AND (@query='' OR instr(lower(name),lower(@query))>0) ORDER BY normalized_name,id LIMIT @limit OFFSET @offset",
);

export function mailDirectory(
  db: Database.Database,
  owner: string,
  self: string,
  query: string,
  limit: number,
  offset: number,
) {
  return mailDirectoryStatement(db)
    .all({ owner, self, query, limit, offset })
    .map((row) => parseRecord(QueryRecords.agents, row, "agents"));
}

const ownedNameStatement = statement(
  "SELECT name FROM agents WHERE owner_id=? AND id=?",
);
const ownedNameRow = QueryRecords.agents.pick({ name: true });
export function ownedName(db: Database.Database, owner: string, id: string) {
  const row = ownedNameStatement(db).get(owner, id);
  return row === undefined
    ? undefined
    : parseRecord(ownedNameRow, row, "agents");
}

const ownedDisplayStatement = statement(
  "SELECT name,provider FROM agents WHERE id=? AND owner_id=?",
);
const ownedDisplayRow = QueryRecords.agents.pick({
  name: true,
  provider: true,
});
export function ownedDisplay(db: Database.Database, id: string, owner: string) {
  const row = ownedDisplayStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(ownedDisplayRow, row, "agents");
}

const activeProfileCountStatement = statement(
  "SELECT count(*) n FROM agents WHERE owner_id=? AND retired_at IS NULL",
);

const activeProfileCountRow = z.object({ n: z.number() });

export function activeProfileCount(db: Database.Database, owner: string) {
  return parseRecord(
    activeProfileCountRow,
    activeProfileCountStatement(db).get(owner),
    "agents",
  );
}

const anyStatement = statement("SELECT 1 FROM agents LIMIT 1");
const anyRow = z.object({ "1": z.number() });
export function any(db: Database.Database) {
  const row = anyStatement(db).get();
  return row === undefined ? undefined : parseRecord(anyRow, row, "agents");
}

const searchIdentityStatement = statement(
  "SELECT name,provider FROM agents WHERE id=? AND owner_id=?",
);
const searchIdentityRow = QueryRecords.agents.pick({
  name: true,
  provider: true,
});
export function searchIdentity(
  db: Database.Database,
  id: string,
  owner: string,
) {
  const row = searchIdentityStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(searchIdentityRow, row, "agents");
}

const ownerCountStatement = statement(
  "SELECT count(*) n FROM agents WHERE owner_id=?",
);
export function ownerCount(db: Database.Database, owner: string) {
  return parseRecord(
    activeProfileCountRow,
    ownerCountStatement(db).get(owner),
    "agents",
  ).n;
}
