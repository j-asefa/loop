import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const rememberStatement = statement(
  "INSERT INTO agent_thread_members(thread_id,agent_id,conversation_id) VALUES(?,?,?) ON CONFLICT(thread_id,agent_id) DO UPDATE SET conversation_id=CASE WHEN (SELECT scope FROM agent_threads WHERE id=excluded.thread_id)='direct' THEN COALESCE(agent_thread_members.conversation_id,excluded.conversation_id) ELSE COALESCE(excluded.conversation_id,agent_thread_members.conversation_id) END",
);
export function remember(
  db: Database.Database,
  thread: string,
  agent: string,
  conversation: string | null,
) {
  return rememberStatement(db).run(thread, agent, conversation);
}

const conversationStatement = statement(
  "SELECT conversation_id FROM agent_thread_members WHERE thread_id=? AND agent_id=?",
);
const conversationRow = QueryRecords.agent_thread_members.pick({
  conversation_id: true,
});
export function conversation(
  db: Database.Database,
  thread: string,
  agent: string | null,
) {
  const row = conversationStatement(db).get(thread, agent);
  return row === undefined
    ? undefined
    : parseRecord(conversationRow, row, "agent_thread_members");
}

const orderedAgentsStatement = statement(
  "SELECT agent_id FROM agent_thread_members WHERE thread_id=? ORDER BY rowid",
);
const orderedAgentsRow = QueryRecords.agent_thread_members.pick({
  agent_id: true,
});
export function orderedAgents(db: Database.Database, thread: string) {
  return orderedAgentsStatement(db)
    .all(thread)
    .map((row) => parseRecord(orderedAgentsRow, row, "agent_thread_members"));
}

const membersStatement = statement(
  "SELECT agent_id,conversation_id FROM agent_thread_members WHERE thread_id=?",
);
const membersRow = QueryRecords.agent_thread_members.pick({
  agent_id: true,
  conversation_id: true,
});
export function members(db: Database.Database, thread: string) {
  return membersStatement(db)
    .all(thread)
    .map((row) => parseRecord(membersRow, row, "agent_thread_members"));
}

const fillConversationStatement = statement(
  "UPDATE agent_thread_members SET conversation_id=?\n          WHERE thread_id=? AND agent_id=? AND conversation_id IS NULL AND ? IS NOT NULL",
);
export function fillConversation(
  db: Database.Database,
  conversation: string | null,
  thread: string,
  agent: string,
  present: string | null,
) {
  return fillConversationStatement(db).run(
    conversation,
    thread,
    agent,
    present,
  );
}
