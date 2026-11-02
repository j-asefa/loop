import * as messagesQueries from "./sql/messages.js";
import { createHash } from "node:crypto";
import type { z } from "zod";
import { FleetMailFile } from "../shared/fleet-mail.js";
import { MAX_UPLOAD_BYTES } from "../shared/uploads.js";
import { db } from "./db.js";
import { ownedArtifact, ownedObject, Problem } from "./domain.js";
import { READABLE_MAIL_SQL } from "./mail-context.js";
import { localArtifact } from "./published-files.js";
import { MailRefusal } from "./agent-mail-policy.js";
import type { Run } from "./queue.js";

export class MailFileRefusal extends MailRefusal {}

/** The same grant applies to local mail and a verified outgoing fleet copy. */
export function sharedMailFiles(run: Run, ids: string[]) {
  const unique = [...new Set(ids)];
  for (const fileId of unique) {
    const published = db
      .prepare(
        "SELECT 1 FROM artifacts a JOIN artifact_objects f ON f.artifact_id=a.id AND f.owner_id=a.owner_id WHERE a.id=? AND a.owner_id=? AND a.agent_id=?",
      )
      .get(fileId, run.owner_id, run.agent_id);
    const attached = messagesQueries.sharedAttachmentReadable(
      db,
      run.owner_id,
      run.conversation_id,
      fileId,
    );
    if (!published && !attached)
      throw new Problem(
        403,
        `File ${fileId} is not one you published or one attached to your conversation.`,
      );
  }
  return unique;
}

function contents(owner: string, fileId: string) {
  const artifact = ownedArtifact(fileId, owner);
  const meta = artifact.metadata;
  if (!meta.upload && meta.uploaded) {
    // Use the bounded descriptor-based reader, including no-follow and digest
    // checks. A modified file on disk must not turn into an unbounded read.
    const file = localArtifact(owner, fileId);
    return {
      ...file,
      name: typeof meta.name === "string" ? meta.name : artifact.title,
    };
  }
  if (!meta.upload || typeof meta.objectId !== "string")
    throw new Problem(404, "This mail file is unavailable.");
  const object = ownedObject(meta.objectId, owner);
  if (object.bytes.length > MAX_UPLOAD_BYTES)
    throw new Problem(413, "Mail files can be up to 25 MiB each.");
  return { bytes: object.bytes, mime: object.mime, name: object.name };
}

export function captureFleetMailFiles(
  run: Run,
  machineId: string,
  ids: string[],
) {
  return sharedMailFiles(run, ids).map((fileId) => {
    try {
      const file = contents(run.owner_id, fileId);
      const descriptor = FleetMailFile.safeParse({
        source: machineId,
        fileId,
        digest: createHash("sha256").update(file.bytes).digest("hex"),
        bytes: file.bytes.length,
        name: file.name,
        mediaType: file.mime,
      });
      if (!descriptor.success)
        throw new MailFileRefusal(409, "A mail file has invalid metadata.");
      return descriptor.data;
    } catch (error) {
      if (error instanceof Problem)
        throw new MailFileRefusal(
          409,
          "A mail file is unavailable or changed.",
        );
      throw error;
    }
  });
}

export function authorizeFleetMailFiles(
  run: Run,
  files: z.infer<typeof FleetMailFile>[],
) {
  try {
    sharedMailFiles(
      run,
      files.map((file) => file.fileId),
    );
    for (const file of files) ownedArtifact(file.fileId, run.owner_id);
  } catch (error) {
    if (error instanceof Problem)
      throw new MailFileRefusal(
        409,
        "An original mail file is no longer authorized.",
      );
    throw error;
  }
}

/** A caller rechecks its native generation and mail grants around each await.
 * This read supplies one immutable, bounded file to the fixed peer protocol. */
export function readFleetMailFile(
  run: Run,
  reference: z.infer<typeof FleetMailFile>,
) {
  authorizeFleetMailFiles(run, [reference]);
  try {
    const file = contents(run.owner_id, reference.fileId);
    if (
      file.bytes.length !== reference.bytes ||
      file.mime !== reference.mediaType ||
      file.name !== reference.name ||
      createHash("sha256").update(file.bytes).digest("hex") !== reference.digest
    )
      throw new MailFileRefusal(
        409,
        "An original mail file changed before transfer.",
      );
    return file.bytes;
  } catch (error) {
    if (error instanceof Problem)
      throw new MailFileRefusal(
        409,
        "An original mail file is unavailable or changed.",
      );
    throw error;
  }
}
