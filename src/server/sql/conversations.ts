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

const insertForkStatement = statement(
  "INSERT INTO conversations(id,owner_id,agent_id,title,origin,external_id,created_at,project_id,execution_connection_id) VALUES(?,?,?,?,?,?,?,?,?)",
);
export function insertFork(
  db: Database.Database,
  id: string,
  owner: string,
  agent: string,
  title: string,
  origin: string,
  external: string | null,
  created: number,
  project: string | null,
  connection: string,
) {
  return insertForkStatement(db).run(
    id,
    owner,
    agent,
    title,
    origin,
    external,
    created,
    project,
    connection,
  );
}

const conversationFolder = (c: string) =>
  `COALESCE(${c}.project_id,(SELECT json_extract(fr.payload,'$.folderId') FROM runs fr WHERE fr.owner_id=${c}.owner_id AND fr.conversation_id=${c}.id ORDER BY fr.created_at DESC,fr.rowid DESC LIMIT 1))`;

const laterTargetStatement = statement(
  `SELECT c.id,c.title,${conversationFolder("c")} folder_id,a.name agent_name,a.provider FROM conversations c LEFT JOIN agents a ON a.id=c.agent_id AND a.owner_id=c.owner_id WHERE c.id=? AND c.owner_id=?`,
);
const laterTargetRow = QueryRecords.conversations
  .pick({ id: true, title: true })
  .extend({
    folder_id: z.string().nullable(),
    agent_name: z.string().nullable(),
    provider: z.string().nullable(),
  });
export function laterTarget(
  db: Database.Database,
  target: string,
  owner: string,
) {
  const row = laterTargetStatement(db).get(target, owner);
  return row === undefined
    ? undefined
    : parseRecord(laterTargetRow, row, "conversations");
}

const setProjectStatement = statement(
  "UPDATE conversations SET project_id=? WHERE id=?",
);
export function setProject(
  db: Database.Database,
  project: string | null,
  id: string,
) {
  return setProjectStatement(db).run(project, id);
}

const ownerStatement = statement(
  "SELECT owner_id FROM conversations WHERE id=?",
);
const ownerRow = QueryRecords.conversations.pick({ owner_id: true });
export function owner(db: Database.Database, id: string) {
  const row = ownerStatement(db).get(id);
  return row === undefined
    ? undefined
    : parseRecord(ownerRow, row, "conversations");
}

const ownedAgentConversationStatement = statement(
  "SELECT * FROM conversations WHERE id=? AND owner_id=? AND agent_id=?",
);

const ownedAgentConversationRow = QueryRecords.conversations;

export function ownedAgentConversation(
  db: Database.Database,
  id: string,
  owner: string,
  agent: string,
) {
  const row = ownedAgentConversationStatement(db).get(id, owner, agent);
  return row === undefined
    ? undefined
    : parseRecord(ownedAgentConversationRow, row, "conversations");
}

const mailTeamConversationStatement = statement(
  "SELECT id FROM conversations WHERE id=? AND owner_id=? AND agent_id=? AND team_id=?",
);

const mailTeamConversationRow = QueryRecords.conversations.pick({ id: true });

export function mailTeamConversation(
  db: Database.Database,
  id: string,
  owner: string,
  agent: string,
  team: string,
) {
  const row = mailTeamConversationStatement(db).get(id, owner, agent, team);
  return row === undefined
    ? undefined
    : parseRecord(mailTeamConversationRow, row, "conversations");
}

const ownedAgentExistsStatement = statement(
  "SELECT 1 FROM conversations WHERE id=? AND owner_id=? AND agent_id=?",
);

const ownedAgentExistsRow = z.object({ "1": z.number() });

export function ownedAgentExists(
  db: Database.Database,
  id: string | null,
  owner: string,
  agent: string,
) {
  const row = ownedAgentExistsStatement(db).get(id, owner, agent);
  return row === undefined
    ? undefined
    : parseRecord(ownedAgentExistsRow, row, "conversations");
}

const byOriginExternalStatement = statement(
  "SELECT id FROM conversations WHERE owner_id=? AND origin=? AND external_id=?",
);

const byOriginExternalRow = QueryRecords.conversations.pick({ id: true });

export function byOriginExternal(
  db: Database.Database,
  owner: string,
  origin: string,
  external: string,
) {
  const row = byOriginExternalStatement(db).get(owner, origin, external);
  return row === undefined
    ? undefined
    : parseRecord(byOriginExternalRow, row, "conversations");
}

const insertImportedStatement = statement(
  "INSERT INTO conversations(id,owner_id,agent_id,title,origin,external_id,created_at) VALUES(?,?,?,?,?,?,?)",
);

export function insertImported(
  db: Database.Database,
  id: string,
  owner: string,
  agent: string,
  title: string,
  origin: string,
  external: string,
  created: number,
) {
  return insertImportedStatement(db).run(
    id,
    owner,
    agent,
    title,
    origin,
    external,
    created,
  );
}

const insertNativeImportStatement = statement(
  "INSERT INTO conversations(id,owner_id,agent_id,title,origin,created_at) VALUES(?,?,?,?,'native',?)",
);
export function insertNativeImport(
  db: Database.Database,
  id: string,
  owner: string,
  agent: string,
  title: string,
  created: number,
) {
  return insertNativeImportStatement(db).run(id, owner, agent, title, created);
}

const ownedRunExistsStatement = statement(
  "SELECT 1 FROM conversations c JOIN runs r ON r.conversation_id=c.id AND r.owner_id=c.owner_id WHERE c.owner_id=? AND c.id=? AND r.id=?",
);

const ownedRunExistsRow = z.object({ "1": z.number() });

export function ownedRunExists(
  db: Database.Database,
  owner: string,
  conversation: string,
  run: string,
) {
  const row = ownedRunExistsStatement(db).get(owner, conversation, run);
  return row === undefined
    ? undefined
    : parseRecord(ownedRunExistsRow, row, "conversations");
}

const insertExternalStatement = statement(
  "INSERT INTO conversations(id,owner_id,agent_id,title,origin,external_id,created_at) VALUES(?,?,?,?,?,?,?)",
);

export function insertExternal(
  db: Database.Database,
  id: string,
  owner: string,
  agent: string,
  title: string,
  origin: string,
  external: string | null,
  created: number,
) {
  return insertExternalStatement(db).run(
    id,
    owner,
    agent,
    title,
    origin,
    external,
    created,
  );
}
