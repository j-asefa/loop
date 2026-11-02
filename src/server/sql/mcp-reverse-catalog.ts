import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const upsertStatement = statement(
  "INSERT INTO mcp_reverse_catalog(peer_id,owner_id,tools,updated_at) VALUES(?,?,?,?)\n     ON CONFLICT(peer_id) DO UPDATE SET tools=excluded.tools,updated_at=excluded.updated_at",
);
export function upsert(
  db: Database.Database,
  peer: string,
  owner: string,
  tools: string,
  updated: number,
) {
  return upsertStatement(db).run(peer, owner, tools, updated);
}

const toolsStatement = statement(
  "SELECT tools FROM mcp_reverse_catalog WHERE owner_id=? AND peer_id=?",
);
const toolsRow = QueryRecords.mcp_reverse_catalog.pick({ tools: true });
export function tools(db: Database.Database, owner: string, peer: string) {
  const row = toolsStatement(db).get(owner, peer);
  return row === undefined
    ? undefined
    : parseRecord(toolsRow, row, "mcp_reverse_catalog");
}
