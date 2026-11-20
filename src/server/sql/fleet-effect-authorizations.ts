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

const mailAuthorityStatement = statement(
  `SELECT 1 FROM fleet_effect_authorizations
   WHERE owner_id=@owner AND effect_kind=@kind AND effect_id=@effect
     AND json_extract(grant_context,'$.operation')='mail'
   UNION ALL SELECT 1 FROM fleet_effect_edit_authorizations
   WHERE owner_id=@owner AND effect_kind=@kind AND effect_id=@effect
     AND json_extract(grant_context,'$.operation')='mail'
   LIMIT 1`,
);
/** Covers incoming Fleet mail, steering, and dependent runs that inherit its grant. */
export function hasMailAuthority(
  db: Database.Database,
  owner: string,
  effect: string,
  kind: "run" | "steering" = "run",
) {
  return mailAuthorityStatement(db).get({ owner, effect, kind }) !== undefined;
}

// Forks and continuations preserve source conversation IDs on copied messages.
// Follow their owner-scoped provenance, including copies of copies.
const conversationSourcesSql = `WITH RECURSIVE sources(id) AS (
  SELECT @conversation
  UNION
  SELECT json_extract(m.metadata,'$.sourceConversation')
  FROM sources s JOIN messages m ON m.conversation_id=s.id AND m.owner_id=@owner
  WHERE m.run_id IS NULL AND json_type(m.metadata,'$.sourceConversation')='text'
)`;
const conversationMailAuthoritySql = `FROM sources s
   JOIN runs r ON r.conversation_id=s.id AND r.owner_id=@owner
   WHERE EXISTS (
     SELECT 1 FROM fleet_effect_authorizations g
     WHERE g.owner_id=r.owner_id AND g.effect_kind='run' AND g.effect_id=r.id
       AND json_extract(g.grant_context,'$.operation')='mail'
     UNION ALL
     SELECT 1 FROM fleet_effect_edit_authorizations g
     WHERE g.owner_id=r.owner_id AND g.effect_kind='run' AND g.effect_id=r.id
       AND json_extract(g.grant_context,'$.operation')='mail'
   )`;
const conversationMailAuthorityStatement = statement(
  `${conversationSourcesSql} SELECT 1 ${conversationMailAuthoritySql} LIMIT 1`,
);
export function conversationHasMailAuthority(
  db: Database.Database,
  owner: string,
  conversation: string,
) {
  return (
    conversationMailAuthorityStatement(db).get({ owner, conversation }) !==
    undefined
  );
}

const conversationMailRunsStatement = statement(
  `${conversationSourcesSql} SELECT r.id ${conversationMailAuthoritySql}`,
);
const conversationMailRunRow = QueryRecords.runs.pick({ id: true });
/** Runs whose persisted authority constrains relayed mail from this conversation. */
export function conversationMailRuns(
  db: Database.Database,
  owner: string,
  conversation: string,
) {
  return conversationMailRunsStatement(db)
    .all({ owner, conversation })
    .map((row) => parseRecord(conversationMailRunRow, row, "runs").id);
}
