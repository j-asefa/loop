import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

// Queries for the experiment_previews table (docs/architecture.md#recipe-add-or-extend-a-sql-table-module).

const parse = (row: unknown) =>
  parseRecord(QueryRecords.experiment_previews, row, "experiment_previews");

const upsertStatement = statement(
  "INSERT INTO experiment_previews(id,owner_id,experiment_id,port,label,path,url,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,?,?) ON CONFLICT(experiment_id,port) DO UPDATE SET label=excluded.label,path=excluded.path,url=excluded.url,active=1,updated_at=excluded.updated_at WHERE owner_id=excluded.owner_id",
);
/** One preview per experiment port; exposing the port again reactivates it. */
export function upsert(
  db: Database.Database,
  preview: {
    id: string;
    owner: string;
    experimentId: string;
    port: number;
    label: string | null;
    path: string;
    url: string;
    now: number;
  },
) {
  upsertStatement(db).run(
    preview.id,
    preview.owner,
    preview.experimentId,
    preview.port,
    preview.label,
    preview.path,
    preview.url,
    preview.now,
    preview.now,
  );
}

const byExperimentStatement = statement(
  "SELECT * FROM experiment_previews WHERE owner_id=? AND experiment_id=? ORDER BY port",
);
export function byExperiment(
  db: Database.Database,
  owner: string,
  experiment: string,
) {
  return byExperimentStatement(db).all(owner, experiment).map(parse);
}

const byPortStatement = statement(
  "SELECT * FROM experiment_previews WHERE owner_id=? AND experiment_id=? AND port=?",
);
export function byPort(
  db: Database.Database,
  owner: string,
  experiment: string,
  port: number,
) {
  const row = byPortStatement(db).get(owner, experiment, port);
  return row === undefined ? undefined : parse(row);
}

const deactivateStatement = statement(
  "UPDATE experiment_previews SET active=0,updated_at=? WHERE owner_id=? AND experiment_id=? AND port=?",
);
export function deactivate(
  db: Database.Database,
  owner: string,
  experiment: string,
  port: number,
  now: number,
) {
  return deactivateStatement(db).run(now, owner, experiment, port).changes;
}

const deactivateAllStatement = statement(
  "UPDATE experiment_previews SET active=0,updated_at=? WHERE owner_id=? AND experiment_id=? AND active=1",
);
/** A destroyed VM serves nothing, so every link of the experiment is disabled. */
export function deactivateAll(
  db: Database.Database,
  owner: string,
  experiment: string,
  now: number,
) {
  return deactivateAllStatement(db).run(now, owner, experiment).changes;
}
