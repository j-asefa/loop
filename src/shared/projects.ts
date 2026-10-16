import type { Folder } from "./types";

export function belongsToProject(
  folderId: string | null | undefined,
  projectId: string,
  folders: Folder[],
) {
  const workspace = folders.some((f) => f.id === projectId && f.is_workspace);
  const visited = new Set<string>();
  while (folderId && !visited.has(folderId)) {
    if (folderId === projectId) return true;
    visited.add(folderId);
    const folder = folders.find((f) => f.id === folderId);
    if (!folder || (workspace && folder.kind === "project")) return false;
    folderId = folder.parent_id;
  }
  return workspace && !folderId;
}
