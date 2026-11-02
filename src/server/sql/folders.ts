import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";
export const FOLDER_PROJECT = `folder_project(id,project_id) AS (
  SELECT id,id FROM folders WHERE owner_id=@owner AND kind='project' AND parent_id IS NULL
  UNION
  SELECT folder_id,project_id FROM project_change_folders
    WHERE owner_id=@owner AND project_id=(SELECT project_id FROM workspace_projects WHERE owner_id=@owner)
  UNION
  SELECT f.id,p.project_id FROM folders f JOIN folder_project p ON f.parent_id=p.id
    WHERE f.owner_id=@owner AND p.project_id IS NOT (SELECT project_id FROM workspace_projects WHERE owner_id=@owner)
)`;

const existsOwnedStatement = statement(
  "SELECT 1 FROM folders WHERE id=? AND owner_id=?",
);
const existsOwnedRow = z.object({ "1": z.number() });
export function existsOwned(db: Database.Database, id: string, owner: string) {
  const row = existsOwnedStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(existsOwnedRow, row, "folders");
}

const ownedStatement = statement(
  "SELECT * FROM folders WHERE id=? AND owner_id=?",
);
export function owned(db: Database.Database, id: string, owner: string) {
  const row = ownedStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.folders, row, "folders");
}

const withProjectsStatement = statement(
  "SELECT f.*,p.path,EXISTS(SELECT 1 FROM workspace_projects w WHERE w.owner_id=f.owner_id AND w.project_id=f.id) is_workspace FROM folders f LEFT JOIN project_paths p ON p.folder_id=f.id WHERE f.owner_id=? ORDER BY f.name",
);
const withProjectsRow = QueryRecords.folders.extend({
  path: z.string().nullable(),
  is_workspace: z.number(),
});
export function withProjects(db: Database.Database, owner: string) {
  return withProjectsStatement(db)
    .all(owner)
    .map((row) => parseRecord(withProjectsRow, row, "folders"));
}

const descendantsStatement = statement(
  "WITH RECURSIVE scope(id) AS (\n    SELECT id FROM folders WHERE owner_id=? AND id=?\n    UNION SELECT f.id FROM folders f JOIN scope s ON f.parent_id=s.id WHERE f.owner_id=?\n  ) SELECT id FROM scope",
);
const descendantsRow = QueryRecords.folders.pick({ id: true });
export function descendants(
  db: Database.Database,
  owner: string,
  folder: string,
  descendantOwner: string,
) {
  return descendantsStatement(db)
    .all(owner, folder, descendantOwner)
    .map((row) => parseRecord(descendantsRow, row, "folders"));
}

const rootProjectsStatement = statement(
  "SELECT id,name FROM folders WHERE owner_id=? AND kind='project' AND parent_id IS NULL",
);
const rootProjectsRow = QueryRecords.folders.pick({ id: true, name: true });
export function rootProjects(db: Database.Database, owner: string) {
  return rootProjectsStatement(db)
    .all(owner)
    .map((row) => parseRecord(rootProjectsRow, row, "folders"));
}

const projectForStatement = statement(
  `WITH RECURSIVE ${FOLDER_PROJECT} SELECT p.id,p.name FROM folder_project fp JOIN folders p ON p.id=fp.project_id AND p.owner_id=@owner WHERE fp.id IS @folder`,
);
const projectForRow = QueryRecords.folders.pick({ id: true, name: true });
export function projectFor(
  db: Database.Database,
  params: { owner: string; folder: string | null },
) {
  const row = projectForStatement(db).get(params);
  return row === undefined
    ? undefined
    : parseRecord(projectForRow, row, "folders");
}

const namedChildrenStatement = statement(
  "SELECT * FROM folders WHERE owner_id=? AND parent_id IS ? AND lower(name)=lower(?)",
);
const namedChildrenRow = QueryRecords.folders;
export function namedChildren(
  db: Database.Database,
  owner: string,
  parent: string | null,
  name: string,
) {
  return namedChildrenStatement(db)
    .all(owner, parent, name)
    .map((row) => parseRecord(namedChildrenRow, row, "folders"));
}

const insertWorkspaceStatement = statement(
  "INSERT INTO folders(id,owner_id,parent_id,kind,name,created_at) VALUES(?,?,NULL,'project','Workspace',?)",
);
export function insertWorkspace(
  db: Database.Database,
  id: string,
  owner: string,
  created: number,
) {
  return insertWorkspaceStatement(db).run(id, owner, created);
}

const byProjectPathStatement = statement(
  "SELECT f.*,p.path FROM folders f JOIN project_paths p ON p.folder_id=f.id WHERE p.path=?",
);
const byProjectPathRow = QueryRecords.folders.extend({ path: z.string() });
export function byProjectPath(db: Database.Database, path: string) {
  const row = byProjectPathStatement(db).get(path);
  return row === undefined
    ? undefined
    : parseRecord(byProjectPathRow, row, "folders");
}

const insertNativeProjectStatement = statement(
  "INSERT INTO folders(id,owner_id,parent_id,kind,name,created_at) VALUES(?,?,NULL,'project',?,?)",
);
export function insertNativeProject(
  db: Database.Database,
  id: string,
  owner: string,
  name: string,
  created: number,
) {
  return insertNativeProjectStatement(db).run(id, owner, name, created);
}

const parentProjectPathStatement = statement(
  "SELECT f.parent_id,p.path FROM folders f LEFT JOIN project_paths p ON p.folder_id=f.id WHERE f.id=? AND f.owner_id=?",
);
const parentProjectPathRow = QueryRecords.folders
  .pick({ parent_id: true })
  .extend({ path: z.string().nullable() });
export function parentProjectPath(
  db: Database.Database,
  folder: string,
  owner: string,
) {
  const row = parentProjectPathStatement(db).get(folder, owner);
  return row === undefined
    ? undefined
    : parseRecord(parentProjectPathRow, row, "folders");
}

const rootProjectCountStatement = statement(
  "SELECT count(*) n FROM folders WHERE owner_id=? AND kind='project' AND parent_id IS NULL",
);
const rootProjectCountRow = z.object({ n: z.number() });
export function rootProjectCount(db: Database.Database, owner: string) {
  return parseRecord(
    rootProjectCountRow,
    rootProjectCountStatement(db).get(owner),
    "folders",
  );
}
