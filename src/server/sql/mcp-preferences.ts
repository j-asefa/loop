import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const approvalModeStatement = statement(
  "SELECT approval_mode FROM mcp_preferences WHERE owner_id=?",
);
const approvalModeRow = QueryRecords.mcp_preferences.pick({
  approval_mode: true,
});
export function approvalMode(db: Database.Database, owner: string) {
  const row = approvalModeStatement(db).get(owner);
  return row === undefined
    ? undefined
    : parseRecord(approvalModeRow, row, "mcp_preferences");
}

const agentPermissionModeStatement = statement(
  "SELECT agent_permission_mode FROM mcp_preferences WHERE owner_id=?",
);
const agentPermissionModeRow = QueryRecords.mcp_preferences.pick({
  agent_permission_mode: true,
});
export function agentPermissionMode(db: Database.Database, owner: string) {
  const row = agentPermissionModeStatement(db).get(owner);
  return row === undefined
    ? undefined
    : parseRecord(agentPermissionModeRow, row, "mcp_preferences");
}

const setAgentPermissionModeStatement = statement(
  "INSERT INTO mcp_preferences(owner_id,approval_mode,agent_permission_mode) VALUES(?,'ask',?) ON CONFLICT(owner_id) DO UPDATE SET agent_permission_mode=excluded.agent_permission_mode",
);
export function setAgentPermissionMode(
  db: Database.Database,
  owner: string,
  mode: string,
) {
  return setAgentPermissionModeStatement(db).run(owner, mode);
}

const setApprovalModeStatement = statement(
  "INSERT INTO mcp_preferences(owner_id,approval_mode) VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET approval_mode=excluded.approval_mode",
);
export function setApprovalMode(
  db: Database.Database,
  owner: string,
  mode: string,
) {
  return setApprovalModeStatement(db).run(owner, mode);
}
