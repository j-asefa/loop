import { db, now } from "./db.js";
import { markDue } from "./briefs/schedule.js";
import { synthesisKinds } from "./briefs/schema.js";

export type ProjectChangeKind =
  | "result"
  | "prompt"
  | "approval_created"
  | "approval_resolved"
  | "decision_created"
  | "decision_resolved"
  | "pr_update"
  | "saved"
  | "unsaved"
  | "label"
  | "mail"
  | "brief_edit"
  | "tombstone";

/** Append inside the caller's transaction. Unassigned work belongs to the default Workspace project once initialized. */
export function recordChange(
  owner: string,
  project: string | null | undefined,
  kind: ProjectChangeKind,
  ref: string,
  conversation?: string | null,
  at = now(),
) {
  const source =
    kind === "result"
      ? "artifact"
      : kind === "prompt"
        ? "message"
        : kind.startsWith("approval_")
          ? "approval"
          : kind.startsWith("decision_")
            ? "decision"
            : null;
  // For records with their own run, use that exact run's project fallback.
  // An unscoped old record must not inherit the conversation's latest run.
  const recordKind =
    source !== null ||
    ["saved", "unsaved", "label", "tombstone"].includes(kind);
  if (recordKind) {
    const inserted = db
      .prepare(
        `INSERT INTO project_changes(owner_id,project_id,kind,ref,conversation_id,at)
      SELECT owner_id,project_id,@kind,ref,conversation_id,@at
      FROM project_change_sources WHERE owner_id=@owner AND ref=@ref
        AND (@source IS NULL OR source=@source)
        AND (@conversation IS NULL OR conversation_id=@conversation)
      LIMIT 1 RETURNING project_id`,
      )
      .get({
        owner,
        kind,
        ref,
        source,
        conversation: conversation ?? null,
        at,
      }) as { project_id: string } | undefined;
    if (inserted && synthesisKinds.some((k) => k === kind))
      markDue(owner, inserted.project_id);
    return;
  }
  const inserted = db
    .prepare(
      `INSERT INTO project_changes(owner_id,project_id,kind,ref,conversation_id,at)
    SELECT @owner,f.project_id,@kind,@ref,c.id,@at FROM project_change_folders f
    LEFT JOIN conversations c ON c.id=@conversation AND c.owner_id=@owner
    WHERE f.owner_id=@owner
      AND (@conversation IS NULL OR c.id IS NOT NULL)
      AND f.folder_id IS COALESCE(c.project_id,@project,(
        SELECT json_extract(r.payload,'$.folderId') FROM runs r
        WHERE r.owner_id=@owner AND r.conversation_id=c.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1
      )) RETURNING project_id`,
    )
    .get({
      owner,
      project: project ?? null,
      kind,
      ref,
      conversation: conversation ?? null,
      at,
    }) as { project_id: string } | undefined;
  if (inserted && synthesisKinds.some((k) => k === kind))
    markDue(owner, inserted.project_id);
}
