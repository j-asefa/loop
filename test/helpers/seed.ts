import type Database from "better-sqlite3";
import type { z } from "zod";
import {
  AgentRecord,
  ConnectionRecord,
  ConversationRecord,
  MessageRecord,
  RunRecord,
} from "../../src/server/sql/rows.js";
import * as connections from "../../src/server/sql/connections.js";
import * as messages from "../../src/server/sql/messages.js";

type ConnectionRow = z.infer<typeof ConnectionRecord>;
type ConnectionSeed = Pick<
  ConnectionRow,
  "id" | "owner_id" | "secret" | "models" | "created_at"
> &
  Partial<Pick<ConnectionRow, "provider" | "label" | "status" | "metadata">>;

/** Current valid rows only; historical and corrupt storage fixtures stay explicit. */
export function seedConnection(db: Database.Database, input: ConnectionSeed) {
  const row = ConnectionRecord.parse({
    provider: "openai",
    label: "Fixture",
    status: "connected",
    metadata: "{}",
    ...input,
  });
  connections.insert(
    db,
    row.id,
    row.owner_id,
    row.provider,
    row.label,
    row.secret,
    row.status,
    row.models,
    row.metadata,
    row.created_at,
  );
  return row;
}

const MessageSeedRecord = MessageRecord.pick({
  id: true,
  owner_id: true,
  conversation_id: true,
  run_id: true,
  role: true,
  content: true,
  metadata: true,
  created_at: true,
});
type MessageSeedRow = z.infer<typeof MessageSeedRecord>;
type MessageSeed = Omit<MessageSeedRow, "run_id" | "metadata"> &
  Partial<Pick<MessageSeedRow, "run_id" | "metadata">>;

/** Ordinals and revisions stay database-managed; imported rowids stay explicit. */
export function seedMessage(db: Database.Database, input: MessageSeed) {
  const row = MessageSeedRecord.parse({
    run_id: null,
    metadata: "{}",
    ...input,
  });
  messages.insert(
    db,
    row.id,
    row.owner_id,
    row.conversation_id,
    row.run_id,
    row.role,
    row.content,
    row.metadata,
    row.created_at,
  );
  return row;
}

type AgentSeedRow = z.infer<typeof AgentRecord>;
type AgentSeed = Pick<
  AgentSeedRow,
  | "id"
  | "owner_id"
  | "name"
  | "normalized_name"
  | "provider"
  | "model"
  | "created_at"
> &
  Partial<AgentSeedRow>;

/** Runtime creation couples names and requires a connection; fixtures preserve both. */
export function seedAgent(db: Database.Database, input: AgentSeed) {
  const row = AgentRecord.parse({
    connection_id: null,
    instructions: "",
    origin: "loop",
    folder_id: null,
    effort: null,
    retired_at: null,
    ...input,
  });
  db.prepare(
    "INSERT INTO agents(id,owner_id,name,normalized_name,provider,connection_id,model,instructions,origin,created_at,folder_id,effort,retired_at) VALUES(@id,@owner_id,@name,@normalized_name,@provider,@connection_id,@model,@instructions,@origin,@created_at,@folder_id,@effort,@retired_at)",
  ).run(row);
  return row;
}

type ConversationSeedRow = z.infer<typeof ConversationRecord>;
type ConversationSeed = Pick<
  ConversationSeedRow,
  "id" | "owner_id" | "title" | "created_at"
> &
  Partial<ConversationSeedRow>;

/** Runtime creation variants require an agent; fixtures also seed unassigned history. */
export function seedConversation(
  db: Database.Database,
  input: ConversationSeed,
) {
  const row = ConversationRecord.parse({
    agent_id: null,
    origin: "loop",
    external_id: null,
    team_id: null,
    execution_connection_id: null,
    project_id: null,
    feed_hidden: 0,
    ...input,
  });
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,origin,external_id,created_at,team_id,execution_connection_id,project_id,feed_hidden) VALUES(@id,@owner_id,@agent_id,@title,@origin,@external_id,@created_at,@team_id,@execution_connection_id,@project_id,@feed_hidden)",
  ).run(row);
  return row;
}

type RunSeedRow = z.infer<typeof RunRecord>;
type RunSeed = Pick<
  RunSeedRow,
  | "id"
  | "owner_id"
  | "input"
  | "state"
  | "idempotency_key"
  | "created_at"
  | "updated_at"
> &
  Partial<RunSeedRow>;

/** Queue/preview creation fixes state, key or times; fixtures preserve each independently. */
export function seedRun(db: Database.Database, input: RunSeed) {
  const row = RunRecord.parse({
    agent_id: null,
    conversation_id: null,
    kind: "agent",
    payload: "{}",
    result: null,
    error: null,
    worker_id: null,
    heartbeat: null,
    active_ms: 0,
    active_since: null,
    attention_dismissed_at: null,
    queue_rank: null,
    ...input,
  });
  db.prepare(
    "INSERT INTO runs(id,owner_id,agent_id,conversation_id,kind,input,state,idempotency_key,payload,result,error,worker_id,heartbeat,created_at,updated_at,active_ms,active_since,attention_dismissed_at,queue_rank) VALUES(@id,@owner_id,@agent_id,@conversation_id,@kind,@input,@state,@idempotency_key,@payload,@result,@error,@worker_id,@heartbeat,@created_at,@updated_at,@active_ms,@active_since,@attention_dismissed_at,@queue_rank)",
  ).run(row);
  return row;
}
