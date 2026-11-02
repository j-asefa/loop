import * as memorySourcesQueries from "./sql/memory-sources.js";
import * as runtimeHostsQueries from "./sql/runtime-hosts.js";
import * as teamsQueries from "./sql/teams.js";
import * as operationsQueries from "./sql/operations.js";
import * as approvalsQueries from "./sql/approvals.js";
import * as mcpConnectionsQueries from "./sql/mcp-connections.js";
import * as workflowsQueries from "./sql/workflows.js";
import * as importsQueries from "./sql/imports.js";
import * as foldersQueries from "./sql/folders.js";
import * as objectsQueries from "./sql/objects.js";
import * as artifactsQueries from "./sql/artifacts.js";
import * as conversationsQueries from "./sql/conversations.js";
import * as connectionsQueries from "./sql/connections.js";
import * as handlesQueries from "./sql/handles.js";
import * as agentsQueries from "./sql/agents.js";
import * as messagesQueries from "./sql/messages.js";
import * as runsQueries from "./sql/runs.js";
import {
  AgentHandle as handle,
  AgentInput as agentInput,
} from "../shared/agent-contract-schemas.js";
import { type Connection } from "./row-schemas.js";
import * as rows from "./row-schemas.js";
import { z } from "zod";
import { db, id, now } from "./db.js";

import { Problem } from "../shared/problem.js";
export { Problem } from "../shared/problem.js";
const ownedQueries = {
  agents: agentsQueries.owned,
  connections: connectionsQueries.owned,
  conversations: conversationsQueries.owned,
  runs: runsQueries.owned,
  messages: messagesQueries.owned,
  artifacts: artifactsQueries.owned,
  objects: objectsQueries.owned,
  folders: foldersQueries.owned,
  imports: importsQueries.owned,
  workflows: workflowsQueries.owned,
  mcp_connections: mcpConnectionsQueries.owned,
  approvals: approvalsQueries.owned,
  operations: operationsQueries.owned,
  teams: teamsQueries.owned,
  runtime_hosts: runtimeHostsQueries.owned,
  memory_sources: memorySourcesQueries.owned,
};
export function owned(table: string, recordId: string, owner: string): unknown {
  if (!Object.hasOwn(ownedQueries, table)) throw new Error("Invalid resource");
  const record = ownedQueries[table as keyof typeof ownedQueries](
    db,
    recordId,
    owner,
  );
  if (!record) throw new Problem(404, "Item not found");
  return record;
}
export {
  AgentHandle as handle,
  AgentInput as agentInput,
} from "../shared/agent-contract-schemas.js";
export function createAgent(owner: string, value: unknown) {
  const data = agentInput.parse(value);
  if (data.folderId) owned("folders", data.folderId, owner);
  const connection = ownedConnection(data.connectionId, owner);
  if (connection.status !== "connected")
    throw new Problem(409, "Reconnect this provider first");
  const models = connection.models as { id: string }[];
  if (!models.some((m) => m.id === data.model))
    throw new Problem(400, "Choose an available model from this connection");
  validateEffort(connection, data.model, data.effort);
  return db
    .transaction(() => {
      if (handlesQueries.exists(db, data.name))
        throw new Problem(409, "That name is taken. Choose another name.");
      const agentId = id();
      agentsQueries.insert(
        db,
        agentId,
        owner,
        data.name,
        data.name,
        connection.provider,
        connection.id,
        data.model,
        data.instructions,
        now(),
        data.folderId || null,
        data.effort || null,
      );
      handlesQueries.insert(db, data.name, agentId, now());
      return ownedAgent(agentId, owner);
    })
    .immediate();
}
export function validateEffort(
  connection: Connection,
  model: string,
  effort?: string | null,
) {
  const selected = (
    connection.models as import("../shared/models.js").ModelOption[]
  ).find((option) => option.id === model);
  if (
    effort &&
    selected?.effortLevels &&
    !selected.effortLevels.some((option) => option.value === effort)
  )
    throw new Problem(400, "Choose an effort level reported by this model");
}
export function renameAgent(owner: string, agentId: string, name: unknown) {
  const normalized = handle.parse(name);
  const agent = ownedAgent(agentId, owner);
  return db
    .transaction(() => {
      const occupied = handlesQueries.agent(db, normalized) as
        { agent_id: string } | undefined;
      if (occupied && occupied.agent_id !== agentId)
        throw new Problem(409, "That name is taken or reserved");
      handlesQueries.reserve(db, normalized, agentId, now());
      agentsQueries.rename(db, normalized, normalized, agentId);
      return { ...agent, name: normalized };
    })
    .immediate();
}

export function ownedRun(recordId: string, owner: string) {
  return rows.parseRun(owned("runs", recordId, owner));
}
export function ownedRunNotice(recordId: string, owner: string) {
  const record = runsQueries.ownedNotice(db, recordId, owner);
  if (!record) throw new Problem(404, "Item not found");
  return rows.parseRecord(rows.RunNotice, record, "runs");
}
export function ownedRunControl(recordId: string, owner: string) {
  const record = runsQueries.ownedControl(db, recordId, owner);
  if (!record) throw new Problem(404, "Item not found");
  return rows.parseRecord(rows.RunControl, record, "runs");
}

export function ownedAgent(recordId: string, owner: string) {
  return rows.parseRecord(
    rows.AgentRecord,
    owned("agents", recordId, owner),
    "agents",
  );
}

export function ownedConnection(recordId: string, owner: string) {
  return rows.parseConnection(owned("connections", recordId, owner));
}

export function ownedConversation(recordId: string, owner: string) {
  return rows.parseRecord(
    rows.ConversationRecord,
    owned("conversations", recordId, owner),
    "conversations",
  );
}

export function ownedMessage(recordId: string, owner: string) {
  return rows.parseMessage(owned("messages", recordId, owner));
}

export function ownedArtifact(recordId: string, owner: string) {
  return rows.parseArtifact(owned("artifacts", recordId, owner));
}

export function ownedObject(recordId: string, owner: string) {
  return rows.parseRecord(
    rows.ObjectRecord,
    owned("objects", recordId, owner),
    "objects",
  );
}

export function ownedFolder(recordId: string, owner: string) {
  return rows.parseRecord(
    rows.FolderRecord,
    owned("folders", recordId, owner),
    "folders",
  );
}

export function ownedImport(recordId: string, owner: string) {
  return rows.parseRecord(
    rows.ImportRecord,
    owned("imports", recordId, owner),
    "imports",
  );
}

export function ownedWorkflow(recordId: string, owner: string) {
  return rows.parseRecord(
    rows.WorkflowRecord,
    owned("workflows", recordId, owner),
    "workflows",
  );
}

export function ownedMcpConnection(recordId: string, owner: string) {
  return rows.parseMcpConnection(owned("mcp_connections", recordId, owner));
}

export function ownedApproval(recordId: string, owner: string) {
  return rows.parseRecord(
    rows.ApprovalRecord,
    owned("approvals", recordId, owner),
    "approvals",
  );
}

export function ownedOperation(recordId: string, owner: string) {
  return rows.parseRecord(
    rows.OperationRecord,
    owned("operations", recordId, owner),
    "operations",
  );
}

export function ownedTeam(recordId: string, owner: string) {
  return rows.parseRecord(
    rows.TeamRecord,
    owned("teams", recordId, owner),
    "teams",
  );
}

export function ownedRuntimeHost(recordId: string, owner: string) {
  return rows.parseRuntimeHost(owned("runtime_hosts", recordId, owner));
}

export function ownedMemorySource(recordId: string, owner: string) {
  return rows.parseRecord(
    rows.MemorySourceRecord,
    owned("memory_sources", recordId, owner),
    "memory_sources",
  );
}
