import { db, id, now } from "./db.js";

export function isWorkspaceProject(owner: string, project: string) {
  return !!db
    .prepare(
      "SELECT 1 FROM workspace_projects WHERE owner_id=? AND project_id=?",
    )
    .get(owner, project);
}

/** Materialize once per owner, including work recorded before Workspace had a
 * brief. This never refiles conversations/runs or enables model generation. */
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
      db.prepare(
        `INSERT INTO project_changes(owner_id,project_id,kind,ref,conversation_id,at)
      SELECT e.owner_id,e.project_id,e.kind,e.ref,e.conversation_id,COALESCE(
        CASE WHEN e.kind='saved' AND e.source='message' THEN (SELECT created_at FROM message_bookmarks WHERE message_id=e.ref AND owner_id=e.owner_id) END,
        CASE e.source
          WHEN 'artifact' THEN (SELECT CASE WHEN e.kind='saved' THEN updated_at ELSE created_at END FROM artifacts WHERE id=e.ref AND owner_id=e.owner_id)
          WHEN 'message' THEN (SELECT created_at FROM messages WHERE id=e.ref AND owner_id=e.owner_id)
          WHEN 'approval' THEN (SELECT created_at FROM approvals WHERE id=e.ref AND owner_id=e.owner_id)
          WHEN 'decision' THEN (SELECT created_at FROM native_decisions WHERE id=e.ref)
        END, @at)
      FROM project_change_entries e WHERE e.owner_id=@owner AND e.project_id=@project
        AND NOT EXISTS(SELECT 1 FROM project_changes p WHERE p.owner_id=e.owner_id AND p.project_id=e.project_id AND p.kind=e.kind AND p.ref=e.ref)
      ORDER BY 6,e.ref,e.kind`,
      ).run({ owner, project, at: now() });
      return project;
    })
    .immediate();
}
