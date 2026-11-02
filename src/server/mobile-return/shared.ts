import { z } from "zod";
import { db } from "../db.js";
import { Problem } from "../domain.js";
import type { UploadedFile } from "../../shared/uploads.js";

/**
 * Composer descriptors for files attached to a stored message, in order, read
 * without loading their bytes. Files that no longer exist are left out; the
 * caller compares counts when a missing file must not go unnoticed.
 */
export function attachmentDescriptors(
  owner: string,
  ids: string[],
): UploadedFile[] {
  if (!ids.length) return [];
  const rows = db
    .prepare(
      `SELECT a.id,o.id objectId,o.name,o.mime,length(o.bytes) size FROM artifacts a
      JOIN objects o ON o.id=json_extract(a.metadata,'$.objectId') AND o.owner_id=a.owner_id
      WHERE a.owner_id=? AND json_extract(a.metadata,'$.upload') IS NOT NULL AND a.id IN (SELECT value FROM json_each(?))`,
    )
    .all(owner, JSON.stringify(ids)) as UploadedFile[];
  return ids.flatMap((fileId) => rows.filter((row) => row.id === fileId));
}

// Every function here takes the owner from authentication. Rows are always
// selected with that owner, so another owner's ids behave as missing.

export const collapse = (text: string | null | undefined, max: number) =>
  (text || "").replace(/\s+/g, " ").trim().slice(0, max);
export const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
export function decode<T>(
  value: string,
  schema: z.ZodType<T>,
  label: string,
): T {
  try {
    return schema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
  } catch {
    throw new Problem(400, `Invalid ${label} cursor`);
  }
}

// Top-level named projects keep their existing grouping. Workspace covers only
// unassigned work and ordinary folders outside an explicit project.
export { FOLDER_PROJECT } from "../sql/folders.js";
import { FOLDER_PROJECT } from "../sql/folders.js";
export function projectFor(owner: string, folder: string | null | undefined) {
  return (
    (db
      .prepare(
        `WITH RECURSIVE ${FOLDER_PROJECT} SELECT p.id,p.name FROM folder_project fp JOIN folders p ON p.id=fp.project_id AND p.owner_id=@owner WHERE fp.id IS @folder`,
      )
      .get({ owner, folder: folder ?? null }) as
      { id: string; name: string } | undefined) || null
  );
}
// A LIKE pattern that matches the text literally.
export const contains = (text: string) =>
  "%" + text.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
