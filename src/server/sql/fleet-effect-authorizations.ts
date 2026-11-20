import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";
import {
  conversationContextSql,
  runInConversationContextSql,
} from "./messages.js";

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

const conversationMailAuthoritySql = `FROM context c
   JOIN runs r ON r.conversation_id=c.id AND r.owner_id=@owner
   WHERE ${runInConversationContextSql} AND EXISTS (
     SELECT 1 FROM fleet_effect_authorizations g
     WHERE g.owner_id=r.owner_id AND g.effect_kind='run' AND g.effect_id=r.id
       AND json_extract(g.grant_context,'$.operation')='mail'
     UNION ALL
     SELECT 1 FROM fleet_effect_edit_authorizations g
     WHERE g.owner_id=r.owner_id AND g.effect_kind='run' AND g.effect_id=r.id
       AND json_extract(g.grant_context,'$.operation')='mail'
       AND (c.at IS NULL OR r.id=c.answer_run OR NOT EXISTS (
         SELECT 1 FROM agent_mail delivery
         WHERE delivery.owner_id=g.owner_id AND delivery.id=g.command_id
           AND delivery.recipient_conversation_id=c.id
           AND COALESCE((
             SELECT dm.created_at>c.at OR (dm.created_at=c.at AND dm.rowid>c.seq)
             FROM messages dm
             WHERE dm.owner_id=delivery.owner_id AND dm.conversation_id=c.id
               AND json_extract(dm.metadata,'$.automation.mailId')=delivery.id
             ORDER BY dm.created_at,dm.rowid LIMIT 1
           ),delivery.sent_at>c.at,0)
       ))
   )`;
const conversationMailAuthorityStatement = statement(
  `${conversationContextSql}
   SELECT 1 WHERE EXISTS (
     SELECT 1 FROM fleet_effect_authorizations WHERE owner_id=@owner AND effect_kind='run'
       AND json_extract(grant_context,'$.operation')='mail'
     UNION ALL
     SELECT 1 FROM fleet_effect_edit_authorizations WHERE owner_id=@owner AND effect_kind='run'
       AND json_extract(grant_context,'$.operation')='mail'
   ) AND EXISTS (SELECT 1 ${conversationMailAuthoritySql})`,
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
  `${conversationContextSql} SELECT DISTINCT r.id ${conversationMailAuthoritySql}`,
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
