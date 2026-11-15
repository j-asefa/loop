import { workspaceLink, downloadLink } from "../shared/workspace-links.js";
import * as artifactsQueries from "./sql/artifacts.js";
import { db } from "./db.js";
import type { CardSchema } from "../shared/cards.js";
import { ResultAttachmentRefSchema } from "../shared/result.js";
import { z } from "zod";
export function cardAttachments(
  owner: string,
  meta: Record<string, unknown>,
): z.input<typeof CardSchema>["attachments"] {
  if (!Array.isArray(meta.attachments)) return [];
  return meta.attachments.flatMap((file: unknown) => {
    if (!file || typeof file !== "object") return [];
    const f = file as Record<string, unknown>;
    if (
      typeof f.id !== "string" ||
      typeof f.name !== "string" ||
      typeof f.mime !== "string" ||
      typeof f.size !== "number" ||
      !Number.isFinite(f.size) ||
      f.size < 0
    )
      return [];
    const target = artifactsQueries.attachmentAuthority(db, f.id, owner);
    if (!target) return [];
    return [
      {
        id: f.id,
        name: f.name,
        mime: f.mime,
        size: f.size,
        href: workspaceLink({ artifact: f.id }),
        download: downloadLink({
          artifactId: target.id,
          objectId: target.object_id,
          published: !!target.published,
        }),
      },
    ];
  });
}

export function resultCardAttachments(
  owner: string,
  attachmentsJson: string,
): z.input<typeof CardSchema>["attachments"] {
  let parsed: z.infer<typeof ResultAttachmentRefSchema>[];
  try {
    parsed = z
      .array(ResultAttachmentRefSchema)
      .parse(JSON.parse(attachmentsJson));
  } catch {
    return [];
  }
  return parsed.flatMap((ref) => {
    const target = artifactsQueries.attachmentAuthority(
      db,
      ref.artifactId,
      owner,
    );
    if (!target) return [];
    return [
      {
        id: ref.artifactId,
        name: ref.name,
        mime: ref.mime,
        size: ref.size,
        href: workspaceLink({ artifact: ref.artifactId }),
        download: downloadLink({
          artifactId: target.id,
          objectId: target.object_id ?? ref.objectId,
          published: Boolean(target.published || ref.published),
        }),
      },
    ];
  });
}
