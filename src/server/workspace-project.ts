import * as workspaceProjectsQueries from "./sql/workspace-projects.js";
import * as foldersQueries from "./sql/folders.js";
import { db, id, now } from "./db.js";

export function isWorkspaceProject(owner: string, project: string) {
  return !!workspaceProjectsQueries.exists(db, owner, project);
}

/** Materialize the default project once per owner without refiling work. */
export function ensureWorkspaceProject(owner: string): string {
  const read = () => workspaceProjectsQueries.forOwner(db, owner)?.project_id;
  const existing = read();
  if (existing) return existing;
  return db
    .transaction(() => {
      const existing = read();
      if (existing) return existing;
      const project = id();
      foldersQueries.insertWorkspace(db, project, owner, now());
      workspaceProjectsQueries.insert(db, owner, project);
      return project;
    })
    .immediate();
}
