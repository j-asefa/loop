import { ArtifactMetadata } from "./row-schemas.js";
import { db, id, now } from "./db.js";
export function saveArtifact(
  owner: string,
  data: {
    title: string;
    kind?: string;
    content: string;
    agent?: string | null;
    conversation?: string | null;
    run?: string | null;
    folder?: string | null;
    metadata?: unknown;
  },
) {
  const artifactId = id(),
    time = now();
  db.prepare(
    "INSERT INTO artifacts(id,owner_id,agent_id,conversation_id,run_id,title,kind,content,metadata,folder_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    artifactId,
    owner,
    data.agent || null,
    data.conversation || null,
    data.run || null,
    data.title,
    data.kind || "markdown",
    data.content,
    JSON.stringify(ArtifactMetadata.parse(data.metadata === undefined ? {} : data.metadata)),
    data.folder || null,
    time,
    time,
  );
  db.prepare("INSERT INTO artifact_versions VALUES(?,?,?,?,?)").run(
    id(),
    artifactId,
    1,
    data.content,
    time,
  );
  return artifactId;
}
