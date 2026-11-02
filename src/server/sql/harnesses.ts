import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const allStatement = statement("SELECT * FROM harnesses ORDER BY name");
const allRow = QueryRecords.harnesses;
export function all(db: Database.Database) {
  return allStatement(db)
    .all()
    .map((row) => parseRecord(allRow, row, "harnesses"));
}

const getStatement = statement("SELECT * FROM harnesses WHERE name=?");
const getRow = QueryRecords.harnesses;
export function get(db: Database.Database, name: string) {
  const row = getStatement(db).get(name);
  return row === undefined ? undefined : parseRecord(getRow, row, "harnesses");
}

const acpOptionsStatement = statement(
  "SELECT options FROM harnesses WHERE name='acp'",
);
const acpOptionsRow = QueryRecords.harnesses.pick({ options: true });
export function acpOptions(db: Database.Database) {
  const row = acpOptionsStatement(db).get();
  return row === undefined
    ? undefined
    : parseRecord(acpOptionsRow, row, "harnesses");
}

const upsertStatement = statement(
  "INSERT INTO harnesses VALUES(?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET options=excluded.options,billing=excluded.billing,capabilities=excluded.capabilities,models=excluded.models,updated_at=excluded.updated_at",
);
export function upsert(
  db: Database.Database,
  name: string,
  options: string,
  billing: string,
  capabilities: string,
  models: string,
  updated: number,
) {
  return upsertStatement(db).run(
    name,
    options,
    billing,
    capabilities,
    models,
    updated,
  );
}

const setOptionsStatement = statement(
  "UPDATE harnesses SET options=? WHERE name=?",
);
export function setOptions(
  db: Database.Database,
  options: string,
  name: string,
) {
  return setOptionsStatement(db).run(options, name);
}
