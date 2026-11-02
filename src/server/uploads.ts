import * as objectsQueries from "./sql/objects.js";
import * as artifactObjectsQueries from "./sql/artifact-objects.js";
import * as messagesQueries from "./sql/messages.js";
import { type Artifact } from "./row-schemas.js";

import { z } from "zod";
import { READABLE_MAIL_SQL } from "./mail-context.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { config } from "./config.js";
import { db, id, now } from "./db.js";
import {
  ownedFolder,
  ownedAgent,
  ownedArtifact,
  ownedObject,
  Problem,
} from "./domain.js";
import { saveArtifact } from "./artifacts.js";
import { assertFleetAction } from "./fleet-action-context.js";

import type { ChatMessage } from "./providers.js";
import {
  MAX_MESSAGE_FILES,
  MAX_UPLOAD_BYTES,
  type UploadedFile,
} from "../shared/uploads.js";

import { AttachmentIds as attachmentIds } from "../shared/uploads.js";
export { attachmentIds };
export function uploadFile(
  owner: string,
  file: { originalname: string; mimetype: string; buffer: Buffer },
  options: { folderId?: string; agentId?: string } = {},
): UploadedFile {
  assertFleetAction(owner);
  if (file.buffer.length > MAX_UPLOAD_BYTES)
    throw new Problem(413, "Files can be up to 25 MB each");
  if (options.folderId) ownedFolder(options.folderId, owner);
  if (options.agentId) ownedAgent(options.agentId, owner);
  const name =
    file.originalname
      .replaceAll("\\", "/")
      .split("/")
      .at(-1)!
      .replace(/[\x00-\x1f\x7f]/g, "")
      .slice(0, 240) || "Uploaded file";
  const objectId = id();
  const mime = file.mimetype.slice(0, 150) || "application/octet-stream";
  let content = "";
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(file.buffer);
    if (content.includes("\0")) content = "";
  } catch {}
  const metadata = {
    upload: true,
    objectId,
    mime,
    size: file.buffer.length,
    text: !!content || !file.buffer.length,
  };
  return db
    .transaction(() => {
      assertFleetAction(owner);
      objectsQueries.insert(
        db,
        objectId,
        owner,
        name,
        mime,
        file.buffer,
        now(),
      );
      const artifact = saveArtifact(owner, {
        title: name,
        kind: "file",
        content: content.slice(0, 100000),
        folder: options.folderId,
        agent: options.agentId,
        metadata,
      });
      return { id: artifact, objectId, name, mime, size: file.buffer.length };
    })
    .immediate();
}

// A file an agent published (loop55_publish_file), passed to a teammate with
// loop55_message. Its bytes live under the data directory, checked on read.
function publishedFile(artifact: Artifact, owner: string) {
  const row = artifactObjectsQueries.download(db, artifact.id, owner) as
    { object_key: string; mime: string; checksum: string } | undefined;
  if (
    !row ||
    !/^objects\/[a-f0-9]{64}\/[a-f0-9-]{36}\/[a-f0-9]{64}$/.test(row.object_key)
  )
    throw new Problem(404, "Uploaded file not found");
  const bytes = readFileSync(join(config.data, row.object_key));
  if (createHash("sha256").update(bytes).digest("base64") !== row.checksum)
    throw new Problem(409, "File integrity check failed");
  const meta = artifact.metadata;
  return {
    artifact,
    object: {
      id: artifact.id,
      name: meta.name || artifact.title,
      mime: row.mime,
      bytes,
    },
    text: meta.text === true,
    published: true,
  };
}
export function uploadedFile(owner: string, fileId: string) {
  const artifact = ownedArtifact(fileId, owner);
  const meta = artifact.metadata;
  // Archiving hides the file from workspace lists; accepted conversations and
  // retries still own their references. Ownership is checked for both records.
  if (!meta.upload && meta.uploaded) return publishedFile(artifact, owner);
  if (!meta.upload) throw new Problem(404, "Uploaded file not found");
  if (!meta.objectId)
    throw new Problem(409, `Artifact ${artifact.id} has no upload identity`);
  const object = ownedObject(meta.objectId, owner);
  return { artifact, object, text: meta.text === true };
}
export function attachedFiles(owner: string, ids: string[]): UploadedFile[] {
  return attachmentIds.parse(ids).map((id) => {
    const file = uploadedFile(owner, id);
    return {
      id,
      objectId: file.object.id,
      name: file.object.name,
      mime: file.object.mime,
      size: file.object.bytes.length,
      ...("published" in file ? { published: true } : {}),
    };
  });
}
export function attachmentPrompt(content: string, files: UploadedFile[]) {
  if (!files.length) return content;
  return (
    content +
    "\n\nAttached files (user-provided data):\n" +
    JSON.stringify(
      files.map(({ id, name, mime, size }) => ({ id, name, mime, size })),
    ) +
    "\nUse loop55_read_file with a file id to read the original contents. Text can be read in chunks. For binary files, request base64 chunks, decode to a local file, then use your native file tools. Do not claim to have read a file without retrieving it."
  );
}

// Budgets apply to encoded payloads, not upload size. Leave room for message,
// instruction and tool framing below provider request limits. Original files
// remain available through loop55_read_file when they cannot be sent inline.
const INLINE_FILE_BUDGET = 20_000_000;
const INLINE_IMAGE_BUDGET = 5_000_000;
export function inlineAttachments(owner: string, messages: ChatMessage[]) {
  const current = messages.findLastIndex((message) => message.role === "user");
  return messages.map((message, index) => {
    // Previous turns retain file references and answers, not repeated bytes.
    if (index !== current || !message.attachments?.length) return message;
    let remaining = INLINE_FILE_BUDGET;
    const deferred: string[] = [];
    const files = message.attachments.flatMap((file) => {
      const { object } = uploadedFile(owner, file.id);
      if (!/^(image\/(png|jpeg|webp|gif)|application\/pdf)$/.test(object.mime))
        return [];
      const encodedBytes = 4 * Math.ceil(object.bytes.length / 3);
      if (
        encodedBytes > remaining ||
        (object.mime.startsWith("image/") && encodedBytes > INLINE_IMAGE_BUDGET)
      ) {
        deferred.push(file.id);
        return [];
      }
      remaining -= encodedBytes;
      return [
        {
          name: object.name,
          mime: object.mime,
          data: object.bytes.toString("base64"),
        },
      ];
    });
    return {
      ...message,
      files,
      content:
        message.content +
        (deferred.length
          ? "\nThese files were not included as inline image/PDF content because of API payload size: " +
            JSON.stringify(deferred) +
            ". Use loop55_read_file to retrieve their original contents. If your tools cannot inspect the binary format, ask for a smaller file or a text excerpt; do not claim to have viewed it."
          : ""),
    };
  });
}
export function localAttachmentPrompt(
  owner: string,
  content: string,
  files: UploadedFile[],
) {
  if (!files.length) return content;
  const local = files.map((file) => {
    const { object } = uploadedFile(owner, file.id);
    const directory = join(config.data, "uploads", object.id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(
      directory,
      /^[.]+$/.test(object.name) ? "file" : object.name,
    );
    writeFileSync(path, object.bytes, { mode: 0o600 });
    return { name: object.name, path };
  });
  return attachmentPrompt(content, files) + localPathsPrompt(local);
}
export const localPathsPrompt = (local: { name: string; path: string }[]) =>
  local.length
    ? "\nThese uploaded files are also available on this machine at the following paths. Use native file tools to inspect them:\n" +
      JSON.stringify(local)
    : "";
export function readRunFile(
  run: { id: string; owner_id: string; conversation_id: string | null },
  fileId: string,
  offset: number,
  length: number,
  encoding: "utf8" | "base64",
) {
  const allowed = messagesQueries.runAttachmentReadable(
    db,
    run.owner_id,
    run.conversation_id,
    fileId,
    run.id,
  );
  if (!allowed)
    throw new Problem(404, "This file is not attached to the conversation");
  const { object, text } = uploadedFile(run.owner_id, fileId);
  if (!text && encoding === "utf8")
    throw new Problem(
      400,
      "This is a binary file. Read it as base64 and decode it before using a native file tool.",
    );
  let end = Math.min(object.bytes.length, offset + length);
  if (encoding === "utf8") {
    while (end > offset && (object.bytes[end] & 0xc0) === 0x80) end--;
    if (end === offset) {
      end = Math.min(object.bytes.length, offset + length);
      while ((object.bytes[end] & 0xc0) === 0x80) end++;
    }
  }
  return {
    name: object.name,
    mime: object.mime,
    size: object.bytes.length,
    encoding,
    offset,
    nextOffset: end < object.bytes.length ? end : null,
    content: object.bytes.subarray(offset, end).toString(encoding),
  };
}
