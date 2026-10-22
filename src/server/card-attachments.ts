import { db } from "./db.js";
import type { Card } from "../shared/cards.js";
export function cardAttachments(
  owner: string,
  meta: Record<string, unknown>,
): Card["attachments"] {
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
    const target = db
      .prepare(
        `SELECT a.id,
      (SELECT o.id FROM objects o WHERE o.owner_id=a.owner_id AND o.id=json_extract(a.metadata,'$.objectId')) object_id,
      EXISTS(SELECT 1 FROM artifact_objects ao WHERE ao.artifact_id=a.id AND ao.owner_id=a.owner_id) published
      FROM artifacts a WHERE a.id=? AND a.owner_id=?`,
      )
      .get(f.id, owner) as
      { id: string; object_id: string | null; published: number } | undefined;
    if (!target) return [];
    return [
      {
        id: f.id,
        name: f.name,
        mime: f.mime,
        size: f.size,
        href: "/?artifact=" + encodeURIComponent(f.id),
        download: target.object_id
          ? "/api/objects/" + encodeURIComponent(target.object_id)
          : target.published
            ? "/api/artifacts/" + encodeURIComponent(target.id) + "/file"
            : null,
      },
    ];
  });
}
