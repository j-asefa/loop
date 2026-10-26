import { PersonalFilesQuery } from "../shared/personal-files.js";
import { db } from "./db.js";
import { projectFolders } from "./results.js";
import { owned } from "./domain.js";
import type {
  PersonalFile,
  PersonalFilesPage,
} from "../shared/personal-files.js";

// Only durable published bytes belong in this library. Feed hiding and
// archiving do not delete a file, and must not make it disappear here.
export function personalFiles(
  owner: string,
  input: unknown,
): PersonalFilesPage {
  const query = PersonalFilesQuery.parse(input);
  const from = `FROM artifact_objects o
    JOIN artifacts a ON a.id=o.artifact_id AND a.owner_id=o.owner_id
    LEFT JOIN agents g ON g.id=a.agent_id AND g.owner_id=a.owner_id
    LEFT JOIN folders f ON f.id=a.folder_id AND f.owner_id=a.owner_id
    LEFT JOIN conversations c ON c.id=a.conversation_id AND c.owner_id=a.owner_id`;
  let where = "o.owner_id=?";
  const params: unknown[] = [owner];
  if (query.q) {
    where +=
      " AND (instr(lower(a.title),lower(?))>0 OR instr(lower(COALESCE(json_extract(a.metadata,'$.name'),'')),lower(?))>0)";
    params.push(query.q, query.q);
  }
  if (query.agent) {
    owned("agents", query.agent, owner);
    where += " AND a.agent_id=?";
    params.push(query.agent);
  }
  if (query.project) {
    owned("folders", query.project, owner);
    where +=
      " AND EXISTS(SELECT 1 FROM json_each(?) WHERE value IS a.folder_id)";
    params.push(JSON.stringify(projectFolders(owner, query.project)));
  }
  const type = `CASE WHEN o.mime LIKE 'image/%' THEN 'image'
    WHEN o.mime LIKE 'video/%' THEN 'video'
    WHEN o.mime IN ('text/html','application/xhtml+xml') THEN 'html' ELSE 'other' END`;
  if (query.type !== "all") {
    where += ` AND (${type})=?`;
    params.push(query.type);
  }
  if (query.before) {
    where += " AND o.rowid<?";
    params.push(query.before);
  }
  const rows = db
    .prepare(
      `SELECT a.id,a.title,
    json_object('name',json_extract(a.metadata,'$.name'),'mime',o.mime,'size',o.size) metadata,
    a.created_at,c.id conversation_id,g.name agent_name,f.name project_name,o.rowid cursor
    ${from} WHERE ${where} ORDER BY o.rowid DESC LIMIT 41`,
    )
    .all(...params) as PersonalFile[];
  return {
    items: rows.slice(0, 40),
    next: rows.length > 40 ? rows[39].cursor : null,
    agents: db
      .prepare(
        `SELECT DISTINCT g.id,g.name ${from} WHERE o.owner_id=? AND g.id IS NOT NULL ORDER BY g.name,g.id`,
      )
      .all(owner) as PersonalFilesPage["agents"],
    projects: db
      .prepare(
        `WITH RECURSIVE ancestors(id,parent_id,name) AS (
      SELECT DISTINCT f.id,f.parent_id,f.name ${from} WHERE o.owner_id=? AND f.id IS NOT NULL
      UNION
      SELECT f.id,f.parent_id,f.name FROM folders f JOIN ancestors child ON child.parent_id=f.id WHERE f.owner_id=?
    ) SELECT id,name FROM ancestors ORDER BY name,id`,
      )
      .all(owner, owner) as PersonalFilesPage["projects"],
  };
}
