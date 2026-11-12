import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement, statementVariants } from "./statement.js";
import { fileArtifactSql, resultOutputSql } from "./artifacts.js";
const revisionStatement = statement(
  "SELECT COALESCE(max(revision),0) revision FROM feed_revisions WHERE owner_id=?",
);
const revisionRow = z.object({ revision: z.number() });
export function revision(db: Database.Database, owner: string) {
  return parseRecord(
    revisionRow,
    revisionStatement(db).get(owner),
    "feed_revisions",
  ).revision;
}
const promptUpdateRow = z.object({
  id: QueryRecords.messages.shape.id.nullable(),
  owner_id: QueryRecords.messages.shape.owner_id.nullable(),
  conversation_id: QueryRecords.messages.shape.conversation_id.nullable(),
  run_id: QueryRecords.messages.shape.run_id.nullable(),
  role: QueryRecords.messages.shape.role.nullable(),
  content: QueryRecords.messages.shape.content.nullable(),
  metadata: QueryRecords.messages.shape.metadata.nullable(),
  created_at: QueryRecords.messages.shape.created_at.nullable(),
  update_key: QueryRecords.messages.shape.update_key.nullable(),
  transcript_ordinal: QueryRecords.messages.shape.transcript_ordinal.nullable(),
  revision: QueryRecords.messages.shape.revision.nullable(),
  change_revision: z.number(),
  changed_id: z.string(),
  cursor: z.number(),
  run_state: z.string().nullable(),
  run_error: z.string().nullable(),
  team_id: z.string().nullable(),
  name: z.string().nullable(),
  provider: z.string().nullable(),
  feed_agent_id: z.string().nullable(),
  folder_id: z.string().nullable(),
});
const artifactUpdateRow = z.object({
  id: QueryRecords.artifacts.shape.id.nullable(),
  owner_id: QueryRecords.artifacts.shape.owner_id.nullable(),
  agent_id: QueryRecords.artifacts.shape.agent_id.nullable(),
  conversation_id: QueryRecords.artifacts.shape.conversation_id.nullable(),
  run_id: QueryRecords.artifacts.shape.run_id.nullable(),
  title: QueryRecords.artifacts.shape.title.nullable(),
  kind: QueryRecords.artifacts.shape.kind.nullable(),
  role: QueryRecords.artifacts.shape.role.nullable(),
  content: QueryRecords.artifacts.shape.content.nullable(),
  metadata: QueryRecords.artifacts.shape.metadata.nullable(),
  folder_id: QueryRecords.artifacts.shape.folder_id.nullable(),
  pinned: QueryRecords.artifacts.shape.pinned.nullable(),
  archived: QueryRecords.artifacts.shape.archived.nullable(),
  version: QueryRecords.artifacts.shape.version.nullable(),
  created_at: QueryRecords.artifacts.shape.created_at.nullable(),
  updated_at: QueryRecords.artifacts.shape.updated_at.nullable(),
  feed_hidden: QueryRecords.artifacts.shape.feed_hidden.nullable(),
  change_revision: z.number(),
  changed_id: z.string(),
  cursor: z.number(),
  run_state: z.string().nullable(),
  run_error: z.string().nullable(),
  team_id: z.string().nullable(),
  name: z.string().nullable(),
  provider: z.string().nullable(),
  output_visible: z.number().nullable(),
});
const updatesStatement = statementVariants();
export function updates(
  db: Database.Database,
  owner: string,
  options: { saved?: boolean; view?: string; after: number; through: number },
  revision: number,
  limit: number,
) {
  const prompts = !options.saved && options.view === "prompts";
  const rows = updatesStatement(
    prompts
      ? `
    SELECT f.revision AS change_revision,f.object_id AS changed_id,f.cursor,m.*,r.state run_state,r.error run_error,c.agent_id AS feed_agent_id,c.team_id,json_extract((SELECT payload FROM runs fr WHERE fr.id=m.run_id),'$.folderId') AS folder_id,g.name,g.provider
    FROM feed_revisions f LEFT JOIN messages m ON m.id=f.object_id AND m.owner_id=f.owner_id
    LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id
    LEFT JOIN conversations c ON c.id=m.conversation_id LEFT JOIN agents g ON g.id=c.agent_id
    WHERE f.owner_id=? AND f.entity='prompt' AND f.revision>? AND f.revision<=? AND f.cursor>=?
    ORDER BY f.revision LIMIT ?
  `
      : `
    SELECT f.revision AS change_revision,f.object_id AS changed_id,COALESCE(p.sequence,f.cursor) AS cursor,a.*,r.state run_state,r.error run_error,json_remove(a.metadata,'$.appResource.html','$.toolResult') AS metadata,g.name,g.provider,c.team_id,(${options.saved || options.view === "files" ? fileArtifactSql : resultOutputSql}) AS output_visible
    FROM feed_revisions f LEFT JOIN artifacts a ON a.id=f.object_id AND a.owner_id=f.owner_id
    LEFT JOIN ${options.saved ? "artifact_bookmarks" : "artifact_publications"} p ON p.artifact_id=f.object_id
    LEFT JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id
    LEFT JOIN agents g ON g.id=a.agent_id LEFT JOIN conversations c ON c.id=a.conversation_id
    WHERE f.owner_id=? AND f.entity='artifact' AND f.revision>? AND f.revision<=? AND (p.sequence>=? OR p.sequence IS NULL)
    ORDER BY f.revision LIMIT ?
  `,
    db,
  ).all(owner, options.after, revision, options.through, limit);
  return prompts
    ? rows.map((row) => parseRecord(promptUpdateRow, row, "feed_revisions"))
    : rows.map((row) => parseRecord(artifactUpdateRow, row, "feed_revisions"));
}

const cardChangesStatement =
  statement(`SELECT revision,entity,object_id FROM feed_revisions
    WHERE owner_id=? AND revision>? AND revision<=? ORDER BY revision LIMIT ?`);
const cardChangesRow = z.object({
  revision: z.number(),
  entity: z.string(),
  object_id: z.string(),
});
export function cardChanges(
  db: Database.Database,
  owner: string,
  after: number,
  revision: number,
  limit: number,
) {
  return cardChangesStatement(db)
    .all(owner, after, revision, limit)
    .map((row) => parseRecord(cardChangesRow, row, "feed_revisions"));
}
