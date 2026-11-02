import {
  PersonalFilesQuery,
  type PersonalFilesPage,
} from "../shared/personal-files.js";
import { db } from "./db.js";
import { projectFolders } from "./results.js";
import { owned } from "./domain.js";
import * as artifactObjectsQueries from "./sql/artifact-objects.js";

// Only durable published bytes belong in this library. Feed hiding and
// archiving do not delete a file, and must not make it disappear here.
export function personalFiles(
  owner: string,
  input: unknown,
): PersonalFilesPage {
  const query = PersonalFilesQuery.parse(input);
  if (query.agent) owned("agents", query.agent, owner);
  if (query.project) owned("folders", query.project, owner);
  return artifactObjectsQueries.library(
    db,
    owner,
    query,
    query.project ? projectFolders(owner, query.project) : undefined,
  );
}
