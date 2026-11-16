import type Database from "better-sqlite3";
import type { z } from "zod";
import type { CardSchema } from "../shared/cards.js";
import type { ResultAttachmentRef } from "../shared/result.js";
import { downloadLink, workspaceLink } from "../shared/workspace-links.js";
import * as artifactsQueries from "./sql/artifacts.js";
import * as resultsQueries from "./sql/results.js";

// Immutable Result attachments. Sealing records which immutable bytes a
// Result published; resolution turns that reference back into a link to
// those bytes under the owner's current access, or reports that the
// published version is unavailable. It never substitutes current bytes.

type MessageAttachment = {
  id?: unknown;
  name?: unknown;
  mime?: unknown;
  size?: unknown;
};

type CardAttachment = z.input<typeof CardSchema>["attachments"][number];

// Message attachments are uploads, whose objects are never rewritten, or
// published files, whose content-addressed objects are insert-only. Sealing
// records which of those bytes the Result published.
export function sealAttachments(
  ownerId: string,
  items: unknown,
  database: Database.Database,
): ResultAttachmentRef[] {
  if (!Array.isArray(items) || items.length === 0) return [];
  const refs: ResultAttachmentRef[] = [];
  for (const item of items as MessageAttachment[]) {
    if (!item || typeof item.id !== "string" || !item.id) continue;
    const artifact = resultsQueries.artifactById(database, ownerId, item.id);
    if (!artifact) continue;
    const artMeta = artifact.metadata as {
      objectId?: unknown;
      mime?: unknown;
      size?: unknown;
    };
    const candidateObjectId =
      typeof artMeta.objectId === "string" && artMeta.objectId.length > 0
        ? artMeta.objectId
        : null;
    const objectId = candidateObjectId
      ? (resultsQueries.ownedObjectId(database, ownerId, candidateObjectId)
          ?.id ?? null)
      : null;
    const publishedObj = resultsQueries.publishedArtifactObject(
      database,
      ownerId,
      artifact.id,
    );
    const name =
      (typeof item.name === "string" && item.name.trim()) ||
      artifact.title?.trim() ||
      artifact.id;
    const mime =
      (typeof item.mime === "string" && item.mime.trim()) ||
      (typeof artMeta.mime === "string" && artMeta.mime.trim()) ||
      publishedObj?.mime ||
      "application/octet-stream";
    const rawSize = item.size ?? artMeta.size ?? publishedObj?.size ?? 0;
    const size =
      typeof rawSize === "number" && Number.isFinite(rawSize) && rawSize >= 0
        ? Math.trunc(rawSize)
        : 0;
    refs.push({
      artifactId: artifact.id,
      objectId,
      version: Math.max(1, Math.trunc(artifact.version || 1)),
      sha256: publishedObj?.checksum ?? null,
      name,
      mime,
      size,
      published: Boolean(publishedObj),
    });
  }
  return refs;
}

// The sealed bytes behind a reference, if they can still be identified:
// the referenced object, or the artifact's published file when its stored
// checksum still matches the one sealed.
function sealedDownload(
  ownerId: string,
  ref: ResultAttachmentRef,
  database: Database.Database,
): string | null {
  if (
    ref.objectId &&
    resultsQueries.ownedObjectId(database, ownerId, ref.objectId)
  ) {
    return downloadLink({
      artifactId: ref.artifactId,
      objectId: ref.objectId,
      published: false,
    });
  }
  if (ref.published && ref.sha256) {
    const current = resultsQueries.publishedArtifactObject(
      database,
      ownerId,
      ref.artifactId,
    );
    if (current?.checksum === ref.sha256) {
      return downloadLink({
        artifactId: ref.artifactId,
        objectId: null,
        published: true,
      });
    }
  }
  return null;
}

// Card links for a sealed Result's attachments. Authorization is the owner's
// current access to the artifact; a historical Result grants none. Preview
// and download both use the sealed bytes. `href` opens the current artifact
// as a separate, explicitly labelled action.
export function resolveResultAttachments(
  ownerId: string,
  refs: ResultAttachmentRef[],
  database: Database.Database,
): CardAttachment[] {
  return refs.flatMap((ref) => {
    const target = artifactsQueries.attachmentAuthority(
      database,
      ref.artifactId,
      ownerId,
    );
    if (!target) return [];
    const download = sealedDownload(ownerId, ref, database);
    return [
      {
        id: ref.artifactId,
        name: ref.name,
        mime: ref.mime,
        size: ref.size,
        href: workspaceLink({ artifact: ref.artifactId }),
        download,
        availability: download ? "sealed" : "unavailable",
      },
    ];
  });
}
