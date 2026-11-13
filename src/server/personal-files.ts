import { z } from "zod";
import {
  PersonalFilesQuery,
  PersonalFilesPage,
} from "../shared/personal-files.js";
import { db } from "./db.js";
import { projectFolders } from "./results.js";
import { ownedAgent, ownedFolder } from "./domain.js";
import * as artifactObjectsQueries from "./sql/artifact-objects.js";

// Only durable published bytes belong in this library. Feed hiding and
// archiving do not delete a file, and must not make it disappear here.
export function personalFiles(
  owner: string,
  input: unknown,
): z.input<typeof PersonalFilesPage> {
  const query = PersonalFilesQuery.parse(input);
  if (query.agent) ownedAgent(query.agent, owner);
  if (query.project) ownedFolder(query.project, owner);
  return artifactObjectsQueries.library(
    db,
    owner,
    query,
    query.project ? projectFolders(owner, query.project) : undefined,
  );
}
