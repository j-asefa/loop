import type { QueryRow } from "./query-records.js";
import { agentPayload } from "./row-schemas.js";

import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  linkSync,
  unlinkSync,
  constants,
  openSync,
  fstatSync,
  readSync,
  closeSync,
} from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { db, emit } from "./db.js";
import { config } from "./config.js";
import { ownedArtifact, ownedConnection, ownedRun, Problem } from "./domain.js";
import { saveArtifact } from "./artifacts.js";
import { runtimeAction, runtimeWorkspaceKey } from "./subscriptions.js";
import { companionMode } from "./profile.js";
import {
  FILE_CHUNK_BYTES,
  MAX_PUBLISHED_BYTES,
  fileMime,
  readPublishedChunk,
} from "../../runtime/published-files.ts";
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
    throw new Problem(413, "Published files can be up to 25 MB");
  const snapshot = agentPayload(run);
  const checksum = createHash("sha256").update(file.bytes).digest("base64");
  const key =
    "objects/" +
    createHash("sha256").update(run.owner_id).digest("hex") +
    "/" +
    run.id +
    "/" +
    createHash("sha256").update(callId).digest("hex");
  const path = join(config.data, key);
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const temporary = path + "." + randomUUID() + ".tmp";
  try {
    writeFileSync(temporary, file.bytes, { flag: "wx", mode: 0o600 });
    // Commit complete bytes without replacing an earlier publication on retry.
    try {
      linkSync(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    try {
      unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (
    createHash("sha256").update(readFileSync(path)).digest("base64") !==
    checksum
  )
    throw new Problem(
      409,
      "File publication identity was reused with different contents",
    );
  return db
    .transaction(() => {
      const live = ownedRun(run.id, run.owner_id);
      if (live.state !== "running")
        throw new Problem(409, "Run is no longer executing");
      const prior = db
        .prepare(
          "SELECT artifact_id FROM artifact_objects WHERE run_id=? AND call_id=? AND owner_id=?",
        )
        .get(run.id, callId, run.owner_id) as
        { artifact_id: string } | undefined;
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
        db.prepare("INSERT INTO artifact_objects VALUES(?,?,?,?,?,?,?,?)").run(
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
        db.prepare(
          "INSERT OR IGNORE INTO artifact_publications(artifact_id) VALUES(?)",
        ).run(aid);
        emit(run.owner_id, run.id, "artifact.published", { artifactId: aid });
      }
      return {
        artifactId: aid,
        url: "/?artifact=" + aid,
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
  const prior = db
    .prepare(
      "SELECT a.id,a.title,a.metadata,f.mime,f.size FROM artifact_objects f JOIN artifacts a ON a.id=f.artifact_id AND a.owner_id=f.owner_id WHERE f.run_id=? AND f.call_id=? AND f.owner_id=?",
    )
    .get(run.id, callId, run.owner_id) as
    | {
        id: string;
        title: string;
        metadata: string;
        mime: string;
        size: number;
      }
    | undefined;
  if (prior)
    return {
      artifactId: prior.id,
      url: "/?artifact=" + prior.id,
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
  const binding =
    companionMode && metadata.loop55Harness
      ? (db
          .prepare(
            "SELECT project FROM companion_sessions WHERE conversation_id=?",
          )
          .get(run.conversation_id) as { project: string } | undefined)
      : undefined;
  if (metadata.loop55Harness && !binding)
    throw new Problem(409, "Native workspace unavailable");
  if (!binding && metadata.authMode !== "subscription")
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
      binding
        ? readPublishedChunk(binding.project, args.path!, offset, version)
        : await runtimeAction(connection, "read-file", {
            workspaceKey: runtimeWorkspaceKey(run.owner_id, run.agent_id!),
            path: args.path,
            offset,
            version,
          }),
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
  const object = db
    .prepare(
      "SELECT * FROM artifact_objects WHERE artifact_id=? AND owner_id=?",
    )
    .get(artifactId, owner) as QueryRow<"artifact_objects"> | undefined;
  if (!object) throw new Problem(404, "Local file unavailable");
  if (
    !/^objects\/[a-f0-9]{64}\/[a-f0-9-]{36}\/[a-f0-9]{64}$/.test(
      object.object_key,
    )
  )
    throw new Problem(409, "Invalid artifact identity");
  if (
    !Number.isSafeInteger(object.size) ||
    object.size < 0 ||
    object.size > MAX_PUBLISHED_BYTES
  )
    throw new Problem(413, "Published files can be up to 25 MB");
  let descriptor: number;
  try {
    descriptor = openSync(
      join(config.data, object.object_key),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Problem(404, "Local file unavailable");
    if ((error as NodeJS.ErrnoException).code === "ELOOP")
      throw new Problem(409, "Invalid artifact identity");
    throw error;
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size !== object.size)
      throw new Problem(409, "Artifact integrity check failed");
    // A growing or replaced file cannot make a download allocate beyond the
    // retained publication's bounded size. Check the same open descriptor.
    const bytes = Buffer.alloc(object.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!count) throw new Problem(409, "Artifact integrity check failed");
      offset += count;
    }
    if (
      readSync(descriptor, Buffer.alloc(1), 0, 1, offset) ||
      createHash("sha256").update(bytes).digest("base64") !== object.checksum
    )
      throw new Problem(409, "Artifact integrity check failed");
    return { bytes, mime: object.mime };
  } finally {
    closeSync(descriptor);
  }
}
