import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const runningGenerationStatement = statement(
  "SELECT 1 FROM companion_sessions WHERE conversation_id=? AND generation=? AND state='running'",
);
const runningGenerationRow = z.object({ "1": z.number() });
export function runningGeneration(
  db: Database.Database,
  conversation: string | null,
  generation: string | null,
) {
  const row = runningGenerationStatement(db).get(conversation, generation);
  return row === undefined
    ? undefined
    : parseRecord(runningGenerationRow, row, "companion_sessions");
}

const projectStatement = statement(
  "SELECT project FROM companion_sessions WHERE conversation_id=?",
);
const projectRow = QueryRecords.companion_sessions.pick({ project: true });
export function project(db: Database.Database, conversation: string | null) {
  const row = projectStatement(db).get(conversation);
  return row === undefined
    ? undefined
    : parseRecord(projectRow, row, "companion_sessions");
}

const getStatement = statement(
  "SELECT * FROM companion_sessions WHERE conversation_id=?",
);

export function get(db: Database.Database, conversation: string) {
  const row = getStatement(db).get(conversation);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.companion_sessions, row, "companion_sessions");
}

const historyListStatement = statement(
  "SELECT n.conversation_id id,n.harness,n.project,n.state,c.title FROM companion_sessions n JOIN conversations c ON c.id=n.conversation_id ORDER BY n.updated_at DESC LIMIT 200",
);
const historyListRow = QueryRecords.companion_sessions
  .pick({ harness: true, project: true, state: true })
  .extend({ id: z.string(), title: z.string() });
export function historyList(db: Database.Database) {
  return historyListStatement(db)
    .all()
    .map((row) => parseRecord(historyListRow, row, "companion_sessions"));
}

const codexConversationStatement = statement(
  "SELECT conversation_id FROM companion_sessions WHERE harness='codex' AND native_id=?",
);
const codexConversationRow = QueryRecords.companion_sessions.pick({
  conversation_id: true,
});
export function codexConversation(db: Database.Database, native: string) {
  const row = codexConversationStatement(db).get(native);
  return row === undefined
    ? undefined
    : parseRecord(codexConversationRow, row, "companion_sessions");
}

const nativeWorkspaceStatement = statement(
  "SELECT conversation_id,project,worktree_source,worktree_agent_id FROM companion_sessions WHERE harness=? AND native_id=?",
);
const nativeWorkspaceRow = QueryRecords.companion_sessions.pick({
  conversation_id: true,
  project: true,
  worktree_source: true,
  worktree_agent_id: true,
});
export function nativeWorkspace(
  db: Database.Database,
  harness: string,
  native: string,
) {
  const row = nativeWorkspaceStatement(db).get(harness, native);
  return row === undefined
    ? undefined
    : parseRecord(nativeWorkspaceRow, row, "companion_sessions");
}

const insertImportedStatement = statement(
  "INSERT INTO companion_sessions(conversation_id,harness,native_id,project,state,updated_at,worktree_source,worktree_agent_id) VALUES(?,?,?,?,'disconnected',?,?,?)",
);
export function insertImported(
  db: Database.Database,
  conversation: string,
  harness: string,
  native: string,
  project: string,
  updated: number,
  source: string | null,
  agent: string,
) {
  return insertImportedStatement(db).run(
    conversation,
    harness,
    native,
    project,
    updated,
    source,
    agent,
  );
}

const nativeHandoffStatement = statement(
  "SELECT conversation_id,project,worktree_agent_id,COALESCE(worktree_source,project) AS source FROM companion_sessions WHERE harness=? AND native_id=?",
);
const nativeHandoffRow = QueryRecords.companion_sessions
  .pick({ conversation_id: true, project: true, worktree_agent_id: true })
  .extend({ source: z.string() });
export function nativeHandoff(
  db: Database.Database,
  harness: string,
  native: string,
) {
  const row = nativeHandoffStatement(db).get(harness, native);
  return row === undefined
    ? undefined
    : parseRecord(nativeHandoffRow, row, "companion_sessions");
}

const generationBindingStatement = statement(
  "SELECT generation,state,harness FROM companion_sessions WHERE conversation_id=?",
);
const generationBindingRow = QueryRecords.companion_sessions.pick({
  generation: true,
  state: true,
  harness: true,
});
export function generationBinding(db: Database.Database, conversation: string) {
  const row = generationBindingStatement(db).get(conversation);
  return row === undefined
    ? undefined
    : parseRecord(generationBindingRow, row, "companion_sessions");
}

const generationStatement = statement(
  "SELECT generation FROM companion_sessions WHERE conversation_id=?",
);
const generationRow = QueryRecords.companion_sessions.pick({
  generation: true,
});
export function generation(db: Database.Database, conversation: string | null) {
  const row = generationStatement(db).get(conversation);
  return row === undefined
    ? undefined
    : parseRecord(generationRow, row, "companion_sessions");
}

const setPermissionStatement = statement(
  "UPDATE companion_sessions SET permission_mode=?,permission_base=?,updated_at=? WHERE conversation_id=? AND generation=?",
);
export function setPermission(
  db: Database.Database,
  mode: string,
  base: string | null,
  updated: number,
  conversation: string,
  generation: string,
) {
  return setPermissionStatement(db).run(
    mode,
    base,
    updated,
    conversation,
    generation,
  );
}

const removeBindingStatement = statement(
  "DELETE FROM companion_sessions WHERE conversation_id=? AND harness=? AND generation IS ? AND native_id IS ? AND project=? AND worktree_agent_id IS ? AND worktree_source IS ?",
);
export function removeBinding(
  db: Database.Database,
  conversation: string,
  harness: string,
  generation: string | null,
  native: string | null,
  project: string,
  agent: string,
  source: string | null,
) {
  return removeBindingStatement(db).run(
    conversation,
    harness,
    generation,
    native,
    project,
    agent,
    source,
  );
}

const insertBindingStatement = statement(
  "INSERT INTO companion_sessions(conversation_id,harness,project,model,instructions,updated_at,effort,worktree_source,worktree_agent_id) VALUES(?,?,?,?,?,?,?,?,?)",
);
export function insertBinding(
  db: Database.Database,
  conversation: string,
  harness: string,
  project: string,
  model: string | null,
  instructions: string,
  updated: number,
  effort: string | null,
  source: string | null,
  agent: string,
) {
  return insertBindingStatement(db).run(
    conversation,
    harness,
    project,
    model,
    instructions,
    updated,
    effort,
    source,
    agent,
  );
}

const clearPermissionStatement = statement(
  "UPDATE companion_sessions SET permission_mode=NULL,permission_base=NULL,updated_at=? WHERE conversation_id=?",
);
export function clearPermission(
  db: Database.Database,
  updated: number,
  conversation: string,
) {
  return clearPermissionStatement(db).run(updated, conversation);
}

const setModelEffortStatement = statement(
  "UPDATE companion_sessions SET model=?,effort=?,updated_at=? WHERE conversation_id=?",
);
export function setModelEffort(
  db: Database.Database,
  model: string | null,
  effort: string | null,
  updated: number,
  conversation: string,
) {
  return setModelEffortStatement(db).run(model, effort, updated, conversation);
}

const markStartingStatement = statement(
  "UPDATE companion_sessions SET generation=?,state='starting',updated_at=? WHERE conversation_id=?",
);
export function markStarting(
  db: Database.Database,
  generation: string,
  updated: number,
  conversation: string,
) {
  return markStartingStatement(db).run(generation, updated, conversation);
}

const markIdleStatement = statement(
  "UPDATE companion_sessions SET state='idle',updated_at=? WHERE conversation_id=?",
);
export function markIdle(
  db: Database.Database,
  updated: number,
  conversation: string,
) {
  return markIdleStatement(db).run(updated, conversation);
}

const failGenerationStatement = statement(
  "UPDATE companion_sessions SET state='failed',updated_at=? WHERE conversation_id=? AND generation=?",
);
export function failGeneration(
  db: Database.Database,
  updated: number,
  conversation: string,
  generation: string,
) {
  return failGenerationStatement(db).run(updated, conversation, generation);
}

const markRunningStatement = statement(
  "UPDATE companion_sessions SET state='running',last_run_id=?,updated_at=? WHERE conversation_id=?",
);
export function markRunning(
  db: Database.Database,
  run: string,
  updated: number,
  conversation: string | null,
) {
  return markRunningStatement(db).run(run, updated, conversation);
}

const disconnectAllStatement = statement(
  "UPDATE companion_sessions SET generation=NULL,state='disconnected'",
);
export function disconnectAll(db: Database.Database) {
  return disconnectAllStatement(db).run();
}

const setNativeIdStatement = statement(
  "UPDATE companion_sessions SET native_id=?,updated_at=? WHERE conversation_id=?",
);
export function setNativeId(
  db: Database.Database,
  native: string,
  updated: number,
  conversation: string,
) {
  return setNativeIdStatement(db).run(native, updated, conversation);
}

const setStateStatement = statement(
  "UPDATE companion_sessions SET state=?,updated_at=? WHERE conversation_id=?",
);
export function setState(
  db: Database.Database,
  state: string,
  updated: number,
  conversation: string,
) {
  return setStateStatement(db).run(state, updated, conversation);
}

const publicSessionStatement = statement(
  "SELECT harness,project,model,state,updated_at FROM companion_sessions WHERE conversation_id=?",
);
const publicSessionRow = QueryRecords.companion_sessions.pick({
  harness: true,
  project: true,
  model: true,
  state: true,
  updated_at: true,
});
export function publicSession(db: Database.Database, conversation: string) {
  const row = publicSessionStatement(db).get(conversation);
  return row === undefined
    ? undefined
    : parseRecord(publicSessionRow, row, "companion_sessions");
}
