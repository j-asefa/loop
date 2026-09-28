import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { config } from "../config.js";
import { createHash } from "node:crypto";
import { db } from "../db.js";
import { storePublishedFile } from "../published-files.js";
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
  if (existing)
    return {
      artifactId: existing.artifact_id,
      url: "/?artifact=" + existing.artifact_id,
      available: true,
    };
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
  return storePublishedFile(run, callId, {
    title: args.title,
    name: basename(args.path),
    mime: file.mime,
    bytes: body,
  });
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
