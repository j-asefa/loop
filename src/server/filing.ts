import * as operationsQueries from "./sql/operations.js";
import * as artifactsQueries from "./sql/artifacts.js";
import * as foldersQueries from "./sql/folders.js";
import { db, id, now } from "./db.js";
import {
  ownedFolder,
  ownedArtifact,
  ownedOperation,
  Problem,
} from "./domain.js";
import type { Folder } from "../shared/types.js";
export function moveArtifact(
  owner: string,
  artifactId: string,
  folderId: string | null,
) {
  return db
    .transaction(() => {
      const a = ownedArtifact(artifactId, owner);
      if (folderId) ownedFolder(folderId, owner);
      const operation = id();
      operationsQueries.insertMove(
        db,
        operation,
        owner,
        a.id,
        JSON.stringify({ folder_id: a.folder_id }),
        a.version + 1,
        now(),
      );
      artifactsQueries.move(db, folderId, now(), a.id);
      return { operation, folderId, message: "Filed. You can undo this move." };
    })
    .immediate();
}
export function undoMove(owner: string, operationId: string) {
  return db
    .transaction(() => {
      const op = ownedOperation(operationId, owner),
        a = ownedArtifact(op.artifact_id, owner);
      if (op.undone || a.version !== op.expected_version)
        throw new Problem(
          409,
          "This item changed after that move. Choose its destination again.",
        );
      const previous = JSON.parse(op.previous);
      if (previous.folder_id) ownedFolder(previous.folder_id, owner);
      artifactsQueries.move(db, previous.folder_id, now(), a.id);
      operationsQueries.markUndone(db, op.id);
      return { ok: true, folderId: previous.folder_id };
    })
    .immediate();
}
export function naturalDestination(owner: string, command: string) {
  const match = command
    .trim()
    .match(
      /^(?:put|move|file|save)\s+(?:this(?:\s+(?:workflow|file|output|artifact))?|it)\s+(?:in|into|to)\s+(.+?)[.!]?$/i,
    );
  if (!match)
    throw new Problem(
      422,
      "Try “Put this in Project / Folder”, or choose a folder below.",
    );
  const path = match[1]
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean);
  let parent: string | null = null;
  for (const part of path) {
    const found = foldersQueries.namedChildren(
      db,
      owner,
      parent,
      part,
    ) as Folder[];
    if (found.length !== 1)
      throw new Problem(
        422,
        `Choose a folder: “${part}” is missing or ambiguous.`,
      );
    parent = found[0].id;
  }
  return parent;
}
