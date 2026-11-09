import * as artifactsQueries from "./sql/artifacts.js";
import * as artifactVersionsQueries from "./sql/artifact-versions.js";
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
  artifactsQueries.insert(
    db,
    artifactId,
    owner,
    data.agent || null,
    data.conversation || null,
    data.run || null,
    data.title,
    data.kind || "markdown",
    data.content,
    JSON.stringify(
      ArtifactMetadata.parse(data.metadata === undefined ? {} : data.metadata),
    ),
    data.folder || null,
    time,
  );
  artifactVersionsQueries.insert(db, id(), artifactId, 1, data.content, time);
  return artifactId;
}
