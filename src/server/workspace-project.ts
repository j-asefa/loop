import { db, id, now } from "./db.js";

export function isWorkspaceProject(owner: string, project: string) {
  return !!db
    .prepare(
      "SELECT 1 FROM workspace_projects WHERE owner_id=? AND project_id=?",
    )
    .get(owner, project);
}

/** Materialize the default project once per owner without refiling work. */
export function ensureWorkspaceProject(owner: string): string {
  const read = () =>
    (
      db
        .prepare("SELECT project_id FROM workspace_projects WHERE owner_id=?")
        .get(owner) as { project_id: string } | undefined
    )?.project_id;
  const existing = read();
  if (existing) return existing;
  return db
    .transaction(() => {
      const existing = read();
      if (existing) return existing;
      const project = id();
      db.prepare(
        "INSERT INTO folders(id,owner_id,parent_id,kind,name,created_at) VALUES(?,?,NULL,'project','Workspace',?)",
      ).run(project, owner, now());
      db.prepare(
        "INSERT INTO workspace_projects(owner_id,project_id) VALUES(?,?)",
      ).run(owner, project);
      return project;
    })
    .immediate();
}
