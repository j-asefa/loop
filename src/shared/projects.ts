import type { Folder } from "./types";

export function belongsToProject(
  folderId: string | null | undefined,
  projectId: string,
  folders: Folder[],
) {
  const visited = new Set<string>();
  while (folderId && !visited.has(folderId)) {
    if (folderId === projectId) return true;
    visited.add(folderId);
    folderId = folders.find((f) => f.id === folderId)?.parent_id;
  }
  return false;
}
