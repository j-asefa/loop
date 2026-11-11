import { MAX_UPLOAD_LABEL } from "../shared/uploads.js";
import { openVerified, storeFile } from "./file-store.js";
import { workspaceLink } from "../shared/workspace-links.js";
import * as artifactObjectsQueries from "./sql/artifact-objects.js";
import * as artifactPublicationsQueries from "./sql/artifact-publications.js";
import * as companionSessionsQueries from "./sql/companion-sessions.js";

import { agentPayload } from "./row-schemas.js";

import { basename } from "node:path";
import { z } from "zod";
import { db, emit } from "./db.js";
import { ownedArtifact, ownedConnection, ownedRun, Problem } from "./domain.js";
import { saveArtifact } from "./artifacts.js";
import {
  FILE_CHUNK_BYTES,
  MAX_PUBLISHED_BYTES,
  fileMime,
  readPublishedChunk,
} from "./published-file-io.js";
import type { Run } from "./queue.js";

export const publishFileSchema = z
  .object({
    path: z.string().min(1).max(4096).optional(),
    title: z.string().trim().min(1).max(180),
    content: z
      .string()
      .max(32000)
      .describe(
        "Inline text or base64, at most 32,000 characters. For larger files, copy the file into the workspace and provide path instead.",
      )
      .optional(),
    encoding: z.enum(["utf8", "base64"]).default("utf8"),
  })
  .refine(
    (args) => (args.path !== undefined) !== (args.content !== undefined),
    "Provide a workspace path or file content, not both",
  );

export function storePublishedFile(
  run: Run,
  callId: string,
  file: { name: string; title: string; mime: string; bytes: Buffer },
) {
  if (ownedRun(run.id, run.owner_id).state !== "running")
    throw new Problem(409, "Run is no longer executing");
  if (file.bytes.length > MAX_PUBLISHED_BYTES)
    throw new Problem(413, `Published files can be up to ${MAX_UPLOAD_LABEL}`);
  const snapshot = agentPayload(run);
  const { key, checksum } = storeFile(run.owner_id, file.bytes);
  return db
    .transaction(() => {
      const live = ownedRun(run.id, run.owner_id);
      if (live.state !== "running")
        throw new Problem(409, "Run is no longer executing");
      const prior = artifactObjectsQueries.forCallId(
        db,
        run.id,
        callId,
        run.owner_id,
      );
      if (
        prior &&
        (prior.checksum !== checksum || prior.size !== file.bytes.length)
      )
        throw new Problem(
          409,
          "File publication identity was reused with different contents",
        );
      const name =
        basename(file.name.replaceAll("\\", "/"))
          .replace(/[\x00-\x1f\x7f]/g, "")
          .slice(0, 240) || "File";
      const text =
        /^(text\/|application\/json$)/.test(file.mime) &&
        file.bytes.length <= 100000 &&
        !file.bytes.includes(0);
      const aid =
        prior?.artifact_id ||
        saveArtifact(run.owner_id, {
          title: file.title,
          kind: "file",
          content: text ? file.bytes.toString("utf8") : "File: " + name,
          agent: run.agent_id,
          conversation: run.conversation_id,
          run: run.id,
          folder: snapshot.folderId,
          metadata: {
            uploaded: true,
            name,
            mime: file.mime,
            size: file.bytes.length,
            checksum,
            text,
            model: snapshot.model,
            provider: snapshot.provider,
          },
        });
      if (!prior) {
        artifactObjectsQueries.insert(
          db,
          aid,
          run.owner_id,
          run.id,
          callId,
          key,
          file.mime,
          file.bytes.length,
          checksum,
        );
        // A published file is already complete, even while its agent keeps working.
        artifactPublicationsQueries.insert(db, aid);
        emit(run.owner_id, run.id, "artifact.published", { artifactId: aid });
      }
      return {
        artifactId: aid,
        url: workspaceLink({ artifact: aid }),
        downloadUrl: "/api/artifacts/" + aid + "/file",
        name,
        mime: file.mime,
        size: file.bytes.length,
        available: true,
      };
    })
    .immediate();
}

export async function publishRunFile(
  run: Run,
  callId: string,
  args: z.infer<typeof publishFileSchema>,
) {
  if (ownedRun(run.id, run.owner_id).state !== "running")
    throw new Problem(409, "Run is no longer executing");
  const prior = artifactObjectsQueries.forCall(
    db,
    run.id,
    callId,
    run.owner_id,
  );
  if (prior)
    return {
      artifactId: prior.id,
      url: workspaceLink({ artifact: prior.id }),
      downloadUrl: "/api/artifacts/" + prior.id + "/file",
      name: JSON.parse(prior.metadata).name || prior.title,
      mime: prior.mime,
      size: prior.size,
      available: true,
    };
  if (args.content !== undefined) {
    const bytes = Buffer.from(args.content, args.encoding);
    if (args.encoding === "base64" && bytes.toString("base64") !== args.content)
      throw new Problem(400, "Invalid base64 file content");
    return storePublishedFile(run, callId, {
      title: args.title,
      name: args.title,
      mime: fileMime(args.title),
      bytes,
    });
  }
  const snapshot = agentPayload(run);
  const connection = ownedConnection(snapshot.connectionId, run.owner_id);
  const metadata = connection.metadata;
  const binding = metadata.loopHarness
    ? companionSessionsQueries.project(db, run.conversation_id)
    : undefined;
  if (metadata.loopHarness && !binding)
    throw new Problem(409, "Native workspace unavailable");
  if (!binding)
    throw new Problem(
      400,
      "This agent has no file workspace. Publish small files using content instead.",
    );
  const chunkSchema = z.object({
    name: z.string().max(240),
    mime: z.string().max(150),
    size: z.number().int().min(0).max(MAX_PUBLISHED_BYTES),
    version: z.string().min(1).max(200),
    offset: z.number().int().min(0),
    nextOffset: z.number().int().min(1).max(MAX_PUBLISHED_BYTES).nullable(),
    base64: z.string().max(Math.ceil(FILE_CHUNK_BYTES / 3) * 4),
  });
  let offset = 0,
    version: string | undefined,
    first: z.infer<typeof chunkSchema> | undefined;
  const chunks: Buffer[] = [];
  for (;;) {
    if (ownedRun(run.id, run.owner_id).state !== "running")
      throw new Problem(409, "Run is no longer executing");
    const chunk = chunkSchema.parse(
      readPublishedChunk(binding.project, args.path!, offset, version),
    );
    const bytes = Buffer.from(chunk.base64, "base64");
    if (
      chunk.offset !== offset ||
      (version && chunk.version !== version) ||
      (first &&
        (chunk.size !== first.size ||
          chunk.name !== first.name ||
          chunk.mime !== first.mime)) ||
      bytes.toString("base64") !== chunk.base64 ||
      bytes.length !== Math.min(FILE_CHUNK_BYTES, chunk.size - offset) ||
      chunk.nextOffset !==
        (offset + bytes.length < chunk.size ? offset + bytes.length : null)
    )
      throw new Problem(409, "File changed or transfer was incomplete");
    first ||= chunk;
    version = chunk.version;
    chunks.push(bytes);
    if (chunk.nextOffset === null) break;
    offset = chunk.nextOffset;
  }
  return storePublishedFile(run, callId, {
    title: args.title,
    name: first!.name,
    mime: first!.mime,
    bytes: Buffer.concat(chunks),
  });
}

export function localArtifact(owner: string, artifactId: string) {
  ownedArtifact(artifactId, owner);
  const object = artifactObjectsQueries.owned(db, artifactId, owner);
  if (!object) throw new Problem(404, "Local file unavailable");
  return {
    bytes: openVerified(object.object_key, object.size, object.checksum),
    mime: object.mime,
  };
}
