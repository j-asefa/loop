import { z } from "zod";
import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const ownedStatement = statement(
  "SELECT * FROM teams WHERE id=? AND owner_id=?",
);
export function owned(db: Database.Database, id: string, owner: string) {
  const row = ownedStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.teams, row, "teams");
}

const latestManagerConversationStatement = statement(
  "SELECT conversation_id,id FROM teams WHERE owner_id=? AND manager_id=? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1",
);
const latestManagerConversationRow = QueryRecords.teams.pick({
  conversation_id: true,
  id: true,
});
export function latestManagerConversation(
  db: Database.Database,
  owner: string,
  agent: string,
) {
  const row = latestManagerConversationStatement(db).get(owner, agent);
  return row === undefined
    ? undefined
    : parseRecord(latestManagerConversationRow, row, "teams");
}

const claimConversationStatement = statement(
  "UPDATE teams SET conversation_id=? WHERE id=? AND owner_id=? AND manager_id=? AND conversation_id IS NULL AND deleted_at IS NULL",
);
export function claimConversation(
  db: Database.Database,
  conversation: string,
  team: string,
  owner: string,
  manager: string,
) {
  return claimConversationStatement(db).run(conversation, team, owner, manager);
}

const hasReviewAgentStatement = statement(
  "SELECT 1 FROM teams t WHERE t.owner_id=? AND t.preset_id='code-review' AND t.deleted_at IS NULL AND (t.manager_id=? OR EXISTS(SELECT 1 FROM team_members m WHERE m.team_id=t.id AND m.agent_id=?))",
);
const hasReviewAgentRow = z.object({ "1": z.number() });
export function hasReviewAgent(
  db: Database.Database,
  owner: string,
  manager: string,
  member: string,
) {
  const row = hasReviewAgentStatement(db).get(owner, manager, member);
  return row === undefined
    ? undefined
    : parseRecord(hasReviewAgentRow, row, "teams");
}

const activeStatement = statement(
  "SELECT * FROM teams WHERE owner_id=? AND deleted_at IS NULL ORDER BY created_at DESC",
);
const activeRow = QueryRecords.teams;
export function active(db: Database.Database, owner: string) {
  return activeStatement(db)
    .all(owner)
    .map((row) => parseRecord(activeRow, row, "teams"));
}

const insertStatement = statement(
  "INSERT INTO teams(id,owner_id,name,manager_id,created_at) VALUES(?,?,?,?,?)",
);
export function insert(
  db: Database.Database,
  id: string,
  owner: string,
  name: string,
  manager: string,
  created: number,
) {
  return insertStatement(db).run(id, owner, name, manager, created);
}

const conversationStatement = statement(
  "UPDATE teams SET conversation_id=? WHERE id=?",
);
export function conversation(
  db: Database.Database,
  conversation: string,
  team: string,
) {
  return conversationStatement(db).run(conversation, team);
}

const presetStatement = statement(
  "UPDATE teams SET preset_id=?,preset_version=?,preset_config=?,folder_id=? WHERE id=?",
);
export function preset(
  db: Database.Database,
  preset: string,
  version: number,
  config: string,
  folder: string | null,
  team: string,
) {
  return presetStatement(db).run(preset, version, config, folder, team);
}

const fullForRestoredAgentStatement = statement(
  "\n    SELECT t.name FROM teams t\n    JOIN team_members membership ON membership.team_id=t.id\n    WHERE t.owner_id=? AND t.deleted_at IS NULL AND membership.agent_id=?\n      AND (SELECT count(*) FROM team_members m\n           JOIN agents a ON a.id=m.agent_id\n           WHERE m.team_id=t.id AND a.retired_at IS NULL) >= 8\n    LIMIT 1\n  ",
);
const fullForRestoredAgentRow = QueryRecords.teams.pick({ name: true });
export function fullForRestoredAgent(
  db: Database.Database,
  owner: string,
  agent: string,
) {
  const row = fullForRestoredAgentStatement(db).get(owner, agent);
  return row === undefined
    ? undefined
    : parseRecord(fullForRestoredAgentRow, row, "teams");
}

const feedVisibilityStatement = statement(
  "UPDATE teams SET hide_results_from_feed=? WHERE id=? AND owner_id=?",
);
export function feedVisibility(
  db: Database.Database,
  hidden: number,
  team: string,
  owner: string,
) {
  return feedVisibilityStatement(db).run(hidden, team, owner);
}

const removeStatement = statement(
  "UPDATE teams SET deleted_at=COALESCE(deleted_at,?) WHERE id=? AND owner_id=?",
);
export function remove(
  db: Database.Database,
  deleted: number,
  team: string,
  owner: string,
) {
  return removeStatement(db).run(deleted, team, owner);
}

const clearManagerConversationStatement = statement(
  "UPDATE teams SET conversation_id=NULL WHERE owner_id=? AND manager_id=? AND deleted_at IS NULL",
);
export function clearManagerConversation(
  db: Database.Database,
  owner: string,
  manager: string,
) {
  return clearManagerConversationStatement(db).run(owner, manager);
}

const setFolderStatement = statement("UPDATE teams SET folder_id=? WHERE id=?");
export function setFolder(
  db: Database.Database,
  folder: string | null,
  id: string,
) {
  return setFolderStatement(db).run(folder, id);
}

const agentInCodeReviewStatement = statement(
  "SELECT 1 FROM teams t WHERE t.owner_id=? AND t.preset_id='code-review' AND t.deleted_at IS NULL AND (t.manager_id=? OR EXISTS(SELECT 1 FROM team_members m WHERE m.team_id=t.id AND m.agent_id=?))",
);

const agentInCodeReviewRow = z.object({ "1": z.number() });

export function agentInCodeReview(
  db: Database.Database,
  owner: string,
  agent: string,
  sameAgent: string,
) {
  const row = agentInCodeReviewStatement(db).get(owner, agent, sameAgent);
  return row === undefined
    ? undefined
    : parseRecord(agentInCodeReviewRow, row, "teams");
}

const activeOwnedStatement = statement(
  "SELECT * FROM teams WHERE id=? AND owner_id=? AND deleted_at IS NULL",
);

const activeOwnedRow = QueryRecords.teams;

export function activeOwned(
  db: Database.Database,
  id: string | null,
  owner: string,
) {
  const row = activeOwnedStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(activeOwnedRow, row, "teams");
}

const agentInActiveTeamStatement = statement(
  "SELECT 1 FROM teams t WHERE t.owner_id=? AND t.deleted_at IS NULL\n       AND (t.manager_id=? OR EXISTS (\n         SELECT 1 FROM team_members m WHERE m.team_id=t.id AND m.agent_id=?\n       )) LIMIT 1",
);

const agentInActiveTeamRow = z.object({ "1": z.number() });

export function agentInActiveTeam(
  db: Database.Database,
  owner: string,
  agent: string,
  sameAgent: string,
) {
  const row = agentInActiveTeamStatement(db).get(owner, agent, sameAgent);
  return row === undefined
    ? undefined
    : parseRecord(agentInActiveTeamRow, row, "teams");
}
