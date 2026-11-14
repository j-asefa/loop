import { readRunPayload } from "../shared/run-payload.js";
import { belongsToProject } from "../shared/projects.js";
import type { Folder } from "../shared/types.js";

export function runMatchesScope(
  payload: string,
  teamSelection: readonly string[],
  projectFilter: string,
  folders: Folder[],
) {
  const scope = readRunPayload(payload, "fallback");
  return (
    (!teamSelection.length ||
      (scope.teamId !== undefined && teamSelection.includes(scope.teamId))) &&
    (!projectFilter || belongsToProject(scope.folderId, projectFilter, folders))
  );
}
