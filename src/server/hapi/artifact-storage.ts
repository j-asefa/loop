import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { createHash } from "node:crypto";
import { db, id } from "../db.js";
import { saveArtifact } from "../artifacts.js";
import { owned, Problem } from "../domain.js";
import type { Run } from "../queue.js";
import { environment, workerRequest } from "./environments.js";
import { sessionFor } from "./adapter.js";
export async function publishFile(
  run: Run,
  callId: string,
  args: { path: string; title: string },
) {
  const existing = db
    .prepare(
      "SELECT artifact_id FROM artifact_objects WHERE run_id=? AND call_id=?",
    )
    .get(run.id, callId) as any;
  if (existing) return { artifactId: existing.artifact_id };
  const session = sessionFor(run.conversation_id!)!,
    e = environment(run.owner_id, session.environment_id);
  const file = await workerRequest(e, "/artifact/read", {
    launchId: session.launch_id,
    generation: session.generation,
    path: args.path,
  });
  const body = Buffer.from(file.base64, "base64");
  if (
    body.length > 10 * 1024 * 1024 ||
    !body.length ||
    ![
      "text/plain",
      "text/markdown",
      "application/pdf",
      "image/png",
      "image/jpeg",
      "application/json",
      "text/csv",
      "application/zip",
    ].includes(file.mime)
  )
    throw new Problem(413, "Artifact type or size is unsupported");
  const checksum = createHash("sha256").update(body).digest("base64");
  if (checksum !== file.checksum)
    throw new Problem(409, "Artifact integrity check failed");
  const objectKey =
    "objects/" +
    createHash("sha256").update(run.owner_id).digest("hex") +
    "/" +
    run.id +
    "/" +
    createHash("sha256").update(callId).digest("hex");
  // Content-addressed key makes upload retries converge; a retry can verify
  // the original bytes but never replace them.
  const path = join(config.data, objectKey);
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path, body, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (
    createHash("sha256").update(readFileSync(path)).digest("base64") !==
    checksum
  )
    throw new Problem(409, "Artifact upload is not confirmed");
  const artifactId = db
    .transaction(() => {
      const prior = db
        .prepare(
          "SELECT artifact_id FROM artifact_objects WHERE run_id=? AND call_id=?",
        )
        .get(run.id, callId) as any;
      if (prior) return prior.artifact_id;
      const aid = saveArtifact(run.owner_id, {
        title: args.title,
        kind: "file",
        content: "Uploaded file: " + args.title,
        agent: run.agent_id,
        conversation: run.conversation_id,
        run: run.id,
        folder: JSON.parse(run.payload).folderId,
        metadata: {
          uploaded: true,
          mime: file.mime,
          size: body.length,
          checksum,
          sourceSession: session.hub_session_id,
          sourcePath: args.path,
        },
      });
      db.prepare("INSERT INTO artifact_objects VALUES(?,?,?,?,?,?,?,?)").run(
        aid,
        run.owner_id,
        run.id,
        callId,
        objectKey,
        file.mime,
        body.length,
        checksum,
      );
      return aid;
    })
    .immediate();
  return { artifactId, url: "/?artifact=" + artifactId, available: true };
}
export async function artifactDownload(owner: string, artifactId: string) {
  owned("artifacts", artifactId, owner);
  const object = db
    .prepare(
      "SELECT * FROM artifact_objects WHERE artifact_id=? AND owner_id=?",
    )
    .get(artifactId, owner) as any;
  if (!object) throw new Problem(404, "No uploaded file is available");
  return "/api/artifacts/" + artifactId + "/file";
}

export function localArtifact(owner: string, artifactId: string) {
  owned("artifacts", artifactId, owner);
  const object = db
    .prepare(
      "SELECT * FROM artifact_objects WHERE artifact_id=? AND owner_id=?",
    )
    .get(artifactId, owner) as any;
  if (!object) throw new Problem(404, "Local file unavailable");
  if (
    !/^objects\/[a-f0-9]{64}\/[a-f0-9-]{36}\/[a-f0-9]{64}$/.test(
      object.object_key,
    )
  )
    throw new Problem(409, "Invalid artifact identity");
  const bytes = readFileSync(join(config.data, object.object_key));
  if (createHash("sha256").update(bytes).digest("base64") !== object.checksum)
    throw new Problem(409, "Artifact integrity check failed");
  return { bytes, mime: object.mime };
}
