import * as memorySourcesQueries from "./sql/memory-sources.js";
import * as teamsQueries from "./sql/teams.js";
import * as operationsQueries from "./sql/operations.js";
import * as approvalsQueries from "./sql/approvals.js";
import * as mcpConnectionsQueries from "./sql/mcp-connections.js";
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
import { db, id, now } from "./db.js";

import { Problem } from "../shared/problem.js";
export { Problem } from "../shared/problem.js";
// Callers supply an owner-scoped query result; foreign and missing rows share a 404.
export function requireOwned<T extends object>(record: T | undefined): T {
  if (record === undefined) throw new Problem(404, "Item not found");
  return record;
}

export {
  AgentHandle as handle,
  AgentInput as agentInput,
} from "../shared/agent-contract-schemas.js";
export function createAgent(owner: string, value: unknown) {
  const data = agentInput.parse(value);
  if (data.folderId) ownedFolder(data.folderId, owner);
  const connection = ownedConnection(data.connectionId, owner);
  validateAgentSelection(connection, () => data);
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
export function validateAgentSelection<
  T extends { model: string; effort?: string | null },
>(
  connection: Connection,
  select: () => T,
  unavailableModel = "Choose an available model from this connection",
): T {
  if (connection.status !== "connected")
    throw new Problem(409, "Reconnect this provider first");
  const selection = select();
  const model = connection.models.find(
    (option) => option.id === selection.model,
  );
  if (!model) throw new Problem(400, unavailableModel);
  if (
    selection.effort &&
    model.effortLevels &&
    !model.effortLevels.some((option) => option.value === selection.effort)
  )
    throw new Problem(400, "Choose an effort level reported by this model");
  return selection;
}
export function renameAgent(owner: string, agentId: string, name: unknown) {
  const normalized = handle.parse(name);
  const agent = ownedAgent(agentId, owner);
  return db
    .transaction(() => {
      const occupied = handlesQueries.agent(db, normalized);
      if (occupied && occupied.agent_id !== agentId)
        throw new Problem(409, "That name is taken or reserved");
      handlesQueries.reserve(db, normalized, agentId, now());
      agentsQueries.rename(db, normalized, agentId);
      return { ...agent, name: normalized };
    })
    .immediate();
}

export function ownedRun(recordId: string, owner: string) {
  return rows.parseRun(requireOwned(runsQueries.owned(db, recordId, owner)));
}
export function ownedRunNotice(recordId: string, owner: string) {
  return requireOwned(runsQueries.ownedNotice(db, recordId, owner));
}
export function ownedRunControl(recordId: string, owner: string) {
  return requireOwned(runsQueries.ownedControl(db, recordId, owner));
}

export function ownedAgent(recordId: string, owner: string) {
  return requireOwned(agentsQueries.owned(db, recordId, owner));
}

export function ownedConnection(recordId: string, owner: string) {
  return rows.parseConnection(
    requireOwned(connectionsQueries.owned(db, recordId, owner)),
  );
}

export function ownedConversation(recordId: string, owner: string) {
  return rows.parseRecord(
    rows.ConversationRecord,
    requireOwned(conversationsQueries.owned(db, recordId, owner)),
    "conversations",
  );
}

export function ownedMessage(recordId: string, owner: string) {
  return rows.parseMessage(
    requireOwned(messagesQueries.owned(db, recordId, owner)),
  );
}

export function ownedArtifact(recordId: string, owner: string) {
  return rows.parseArtifact(
    requireOwned(artifactsQueries.owned(db, recordId, owner)),
  );
}

export function ownedObject(recordId: string, owner: string) {
  return requireOwned(objectsQueries.owned(db, recordId, owner));
}

export function ownedFolder(recordId: string, owner: string) {
  return requireOwned(foldersQueries.owned(db, recordId, owner));
}

export function ownedImport(recordId: string, owner: string) {
  return requireOwned(importsQueries.owned(db, recordId, owner));
}

export function ownedMcpConnection(recordId: string, owner: string) {
  return rows.parseMcpConnection(
    requireOwned(mcpConnectionsQueries.owned(db, recordId, owner)),
  );
}

export function ownedApproval(recordId: string, owner: string) {
  return requireOwned(approvalsQueries.owned(db, recordId, owner));
}

export function ownedOperation(recordId: string, owner: string) {
  return requireOwned(operationsQueries.owned(db, recordId, owner));
}

export function ownedTeam(recordId: string, owner: string) {
  return requireOwned(teamsQueries.owned(db, recordId, owner));
}

export function ownedMemorySource(recordId: string, owner: string) {
  return requireOwned(memorySourcesQueries.owned(db, recordId, owner));
}
