import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const commandGrantsStatement = statement(
  "\n    SELECT grant_context FROM fleet_effect_authorizations\n    WHERE owner_id=@owner AND effect_kind=@kind AND effect_id=@effectId AND command_id=@commandId\n    UNION ALL SELECT grant_context FROM fleet_effect_edit_authorizations\n    WHERE owner_id=@owner AND effect_kind=@kind AND effect_id=@effectId AND command_id=@commandId\n  ",
);
const commandGrantsRow = QueryRecords.fleet_effect_authorizations.pick({
  grant_context: true,
});
export function commandGrants(
  db: Database.Database,
  key: { owner: string; kind: string; effectId: string; commandId: string },
) {
  return commandGrantsStatement(db)
    .all(key)
    .map((row) =>
      parseRecord(commandGrantsRow, row, "fleet_effect_authorizations"),
    );
}

const insertStatement = statement(
  "INSERT INTO fleet_effect_authorizations VALUES(?,?,?,?,?)",
);
export function insert(
  db: Database.Database,
  owner: string,
  kind: string,
  effect: string,
  command: string,
  grant: string,
) {
  return insertStatement(db).run(owner, kind, effect, command, grant);
}

const commandsStatement = statement(
  "SELECT command_id,grant_context FROM fleet_effect_authorizations\n    WHERE owner_id=@owner AND effect_kind=@kind AND effect_id=@effectId\n    UNION ALL SELECT command_id,grant_context FROM fleet_effect_edit_authorizations\n    WHERE owner_id=@owner AND effect_kind=@kind AND effect_id=@effectId",
);
const commandsRow = QueryRecords.fleet_effect_authorizations.pick({
  command_id: true,
  grant_context: true,
});
export function commands(
  db: Database.Database,
  key: { owner: string; kind: string; effectId: string },
) {
  return commandsStatement(db)
    .all(key)
    .map((row) => parseRecord(commandsRow, row, "fleet_effect_authorizations"));
}

const grantsStatement = statement(
  "SELECT grant_context FROM fleet_effect_authorizations WHERE owner_id=@owner AND effect_kind=@kind AND effect_id=@effectId\n       UNION ALL SELECT grant_context FROM fleet_effect_edit_authorizations WHERE owner_id=@owner AND effect_kind=@kind AND effect_id=@effectId",
);
const grantsRow = QueryRecords.fleet_effect_authorizations.pick({
  grant_context: true,
});
export function grants(
  db: Database.Database,
  key: { owner: string; kind: string; effectId: string },
) {
  return grantsStatement(db)
    .all(key)
    .map((row) => parseRecord(grantsRow, row, "fleet_effect_authorizations"));
}

const firstCommandStatement = statement(
  "SELECT command_id,grant_context FROM fleet_effect_authorizations\n       WHERE owner_id=@owner AND effect_kind=@kind AND effect_id=@effectId\n       UNION ALL SELECT command_id,grant_context FROM fleet_effect_edit_authorizations\n       WHERE owner_id=@owner AND effect_kind=@kind AND effect_id=@effectId LIMIT 1",
);
const firstCommandRow = QueryRecords.fleet_effect_authorizations.pick({
  command_id: true,
  grant_context: true,
});
export function firstCommand(
  db: Database.Database,
  key: { owner: string; kind: string; effectId: string },
) {
  const row = firstCommandStatement(db).get(key);
  return row === undefined
    ? undefined
    : parseRecord(firstCommandRow, row, "fleet_effect_authorizations");
}
