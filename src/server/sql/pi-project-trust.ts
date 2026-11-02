import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const decisionStatement = statement(
  "SELECT trusted,fingerprint FROM pi_project_trust WHERE owner_id=? AND project=?",
);
const decisionRow = QueryRecords.pi_project_trust.pick({
  trusted: true,
  fingerprint: true,
});
export function decision(
  db: Database.Database,
  owner: string,
  project: string,
) {
  const row = decisionStatement(db).get(owner, project);
  return row === undefined
    ? undefined
    : parseRecord(decisionRow, row, "pi_project_trust");
}

const trustedStatement = statement(
  "SELECT trusted FROM pi_project_trust WHERE owner_id=? AND project=?",
);
const trustedRow = QueryRecords.pi_project_trust.pick({ trusted: true });
export function trusted(db: Database.Database, owner: string, project: string) {
  const row = trustedStatement(db).get(owner, project);
  return row === undefined
    ? undefined
    : parseRecord(trustedRow, row, "pi_project_trust");
}

const refreshStatement = statement(
  "UPDATE pi_project_trust SET fingerprint=?,decided_at=? WHERE owner_id=? AND project=?",
);
export function refresh(
  db: Database.Database,
  fingerprint: string,
  decided: number,
  owner: string,
  project: string,
) {
  return refreshStatement(db).run(fingerprint, decided, owner, project);
}

const upsertStatement = statement(
  "INSERT INTO pi_project_trust(owner_id,project,fingerprint,trusted,decided_at) VALUES(?,?,?,?,?) ON CONFLICT(owner_id,project) DO UPDATE SET fingerprint=excluded.fingerprint,trusted=excluded.trusted,decided_at=excluded.decided_at",
);
export function upsert(
  db: Database.Database,
  owner: string,
  project: string,
  fingerprint: string,
  trusted: number,
  decided: number,
) {
  return upsertStatement(db).run(owner, project, fingerprint, trusted, decided);
}
