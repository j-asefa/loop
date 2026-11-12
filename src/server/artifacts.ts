import * as artifactsQueries from "./sql/artifacts.js";
import * as artifactVersionsQueries from "./sql/artifact-versions.js";
import { parseArtifactMetadata } from "./row-schemas.js";
import { db, id, now } from "./db.js";
import {
  DefaultArtifactKind,
  type ArtifactKind,
} from "../shared/artifact-kind.js";
import type { ArtifactRole } from "../shared/artifact-role.js";
export function saveArtifact(
  owner: string,
  data: {
    title: string;
    kind?: ArtifactKind;
    role: ArtifactRole;
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
    data.kind || DefaultArtifactKind,
    data.role,
    data.content,
    JSON.stringify(
      parseArtifactMetadata(
        data.role,
        data.metadata === undefined ? {} : data.metadata,
      ),
    ),
    data.folder || null,
    time,
  );
  artifactVersionsQueries.insert(db, id(), artifactId, 1, data.content, time);
  return artifactId;
}
