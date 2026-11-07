import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const upsertStatement = statement(
  "INSERT INTO run_verifications(id,owner_id,run_id,conversation_id,generation,source_id,kind,tools,command,status,exit_code,truncated,output_tail,observed_at)\n     VALUES(@id,@owner,@run,@conversation,@generation,@source,@kind,@tools,@command,@status,@exit,@truncated,@tail,@at)\n     ON CONFLICT(run_id,source_id) DO UPDATE SET kind=excluded.kind,tools=excluded.tools,command=excluded.command,status=excluded.status,exit_code=excluded.exit_code,truncated=excluded.truncated,output_tail=excluded.output_tail,observed_at=excluded.observed_at",
);
export function upsert(
  db: Database.Database,
  params: {
    id: string;
    owner: string;
    run: string;
    conversation: string | null;
    generation: string | null;
    source: string;
    kind: string;
    tools: string;
    command: string;
    status: string;
    exit: number | null;
    truncated: number;
    tail: string | null;
    at: number;
  },
) {
  return upsertStatement(db).run(params);
}

const forRunStatement = statement(
  "SELECT * FROM run_verifications WHERE owner_id=? AND run_id=? ORDER BY observed_at,rowid",
);
const forRunRow = QueryRecords.run_verifications;
export function forRun(db: Database.Database, owner: string, run: string) {
  return forRunStatement(db)
    .all(owner, run)
    .map((row) => parseRecord(forRunRow, row, "run_verifications"));
}
