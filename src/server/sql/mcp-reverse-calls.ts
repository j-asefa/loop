import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const byRequestStatement = statement(
  "SELECT * FROM mcp_reverse_calls WHERE peer_id=? AND run_key=? AND request_key=?",
);
const byRequestRow = QueryRecords.mcp_reverse_calls;
export function byRequest(
  db: Database.Database,
  peer: string,
  run: string,
  request: string,
) {
  const row = byRequestStatement(db).get(peer, run, request);
  return row === undefined
    ? undefined
    : parseRecord(byRequestRow, row, "mcp_reverse_calls");
}

const insertPendingStatement = statement(
  "INSERT INTO mcp_reverse_calls(id,owner_id,peer_id,run_key,request_key,tool_name,args,state,created_at,updated_at)\n     VALUES(?,?,?,?,?,?,?,'pending',?,?)",
);
export function insertPending(
  db: Database.Database,
  id: string,
  owner: string,
  peer: string,
  run: string,
  request: string,
  tool: string,
  args: string,
  created: number,
  updated: number,
) {
  return insertPendingStatement(db).run(
    id,
    owner,
    peer,
    run,
    request,
    tool,
    args,
    created,
    updated,
  );
}

const unknownInactiveRunsStatement = statement(
  "UPDATE mcp_reverse_calls SET state='unknown',updated_at=?\n     WHERE owner_id=? AND peer_id=? AND state IN ('pending','claimed') AND run_key IN\n     (SELECT id FROM runs WHERE state NOT IN ('running','awaiting_approval'))",
);
export function unknownInactiveRuns(
  db: Database.Database,
  time: number,
  owner: string,
  peer: string,
) {
  return unknownInactiveRunsStatement(db).run(time, owner, peer);
}

const pendingStatement = statement(
  "SELECT id,run_key AS runKey,request_key AS requestKey,tool_name AS name,args\n       FROM mcp_reverse_calls WHERE owner_id=? AND peer_id=? AND state='pending'\n       ORDER BY created_at LIMIT 20",
);
const pendingRow = z.object({
  id: z.string(),
  runKey: z.string(),
  requestKey: z.string(),
  name: z.string(),
  args: z.string(),
});
export function pending(db: Database.Database, owner: string, peer: string) {
  return pendingStatement(db)
    .all(owner, peer)
    .map((row) => parseRecord(pendingRow, row, "mcp_reverse_calls"));
}

const claimStatement = statement(
  "UPDATE mcp_reverse_calls SET state='claimed',updated_at=?\n         WHERE id=? AND owner_id=? AND peer_id=? AND state='pending' AND run_key IN\n         (SELECT id FROM runs WHERE state IN ('running','awaiting_approval'))",
);
export function claim(
  db: Database.Database,
  time: number,
  id: string,
  owner: string,
  peer: string,
) {
  return claimStatement(db).run(time, id, owner, peer);
}

const ownedPeerStatement = statement(
  "SELECT * FROM mcp_reverse_calls WHERE id=? AND owner_id=? AND peer_id=?",
);
const ownedPeerRow = QueryRecords.mcp_reverse_calls;
export function ownedPeer(
  db: Database.Database,
  id: string,
  owner: string,
  peer: string,
) {
  const row = ownedPeerStatement(db).get(id, owner, peer);
  return row === undefined
    ? undefined
    : parseRecord(ownedPeerRow, row, "mcp_reverse_calls");
}

const settleStatement = statement(
  "UPDATE mcp_reverse_calls SET state=?,result=?,updated_at=? WHERE id=? AND state IN ('pending','claimed')",
);
export function settle(
  db: Database.Database,
  state: string,
  result: string | null,
  time: number,
  id: string,
) {
  return settleStatement(db).run(state, result, time, id);
}

const markUnknownStatement = statement(
  "UPDATE mcp_reverse_calls SET state='unknown',updated_at=? WHERE id=? AND owner_id=? AND state IN ('pending','claimed') RETURNING run_key",
);
const markUnknownRow = QueryRecords.mcp_reverse_calls.pick({ run_key: true });
export function markUnknown(
  db: Database.Database,
  time: number,
  id: string,
  owner: string,
) {
  const row = markUnknownStatement(db).get(time, id, owner);
  return row === undefined
    ? undefined
    : parseRecord(markUnknownRow, row, "mcp_reverse_calls");
}

const ownedStatement = statement(
  "SELECT * FROM mcp_reverse_calls WHERE id=? AND owner_id=?",
);
const ownedRow = QueryRecords.mcp_reverse_calls;
export function owned(db: Database.Database, id: string, owner: string) {
  const row = ownedStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(ownedRow, row, "mcp_reverse_calls");
}

const receiptStatement = statement(
  "SELECT state,result FROM mcp_reverse_calls WHERE id=? AND owner_id=?",
);
const receiptRow = QueryRecords.mcp_reverse_calls.pick({
  state: true,
  result: true,
});
export function receipt(db: Database.Database, id: string, owner: string) {
  const row = receiptStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(receiptRow, row, "mcp_reverse_calls");
}

const unknownPeerStatement = statement(
  "UPDATE mcp_reverse_calls SET state='unknown',updated_at=? WHERE owner_id=? AND peer_id=? AND state IN ('pending','claimed') RETURNING id,run_key",
);
const unknownPeerRow = QueryRecords.mcp_reverse_calls.pick({
  id: true,
  run_key: true,
});
export function unknownPeer(
  db: Database.Database,
  time: number,
  owner: string,
  peer: string,
) {
  return unknownPeerStatement(db)
    .all(time, owner, peer)
    .map((row) => parseRecord(unknownPeerRow, row, "mcp_reverse_calls"));
}
