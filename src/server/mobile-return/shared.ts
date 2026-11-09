import * as foldersQueries from "../sql/folders.js";
import * as artifactsQueries from "../sql/artifacts.js";
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
  const rows = artifactsQueries.attachmentDescriptors(
    db,
    owner,
    JSON.stringify(ids),
  ) as UploadedFile[];
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
export function projectFor(owner: string, folder: string | null | undefined) {
  return (
    (foldersQueries.projectFor(db, { owner, folder: folder ?? null }) as
      { id: string; name: string } | undefined) || null
  );
}
// A LIKE pattern that matches the text literally.
export const contains = (text: string) =>
  "%" + text.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
