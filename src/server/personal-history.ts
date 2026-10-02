import { db } from "./db.js";
import { Problem } from "./domain.js";
import { z } from "zod";

type HistoryRow = {
  id: string;
  content: string;
  created_at: number;
  conversation_id: string;
  attachments: string | null;
  conversation_title: string;
  agent_name: string | null;
  provider: string | null;
  agent_id: string | null;
  project_name: string | null;
};

// Prompts you sent yourself: user messages of your own agent runs, not
// delegated, imported or forwarded ones. Shared by the list and its count.
const PROMPTS_WITH = `WITH RECURSIVE folder_project(id,owner_id,project_id) AS (
      SELECT id,owner_id,id FROM folders WHERE kind='project' AND parent_id IS NULL
      UNION ALL
      SELECT f.id,f.owner_id,p.project_id FROM folders f
      JOIN folder_project p ON f.parent_id=p.id AND f.owner_id=p.owner_id
    )`;
const PROMPTS_FROM = `    FROM messages m
    JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
    JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id AND r.conversation_id=c.id
    LEFT JOIN agents a ON a.id=r.agent_id AND a.owner_id=m.owner_id
    LEFT JOIN folder_project fp ON fp.id=COALESCE(json_extract(r.payload,'$.folderId'),c.project_id) AND fp.owner_id=m.owner_id
    LEFT JOIN folders project ON project.id=fp.project_id AND project.owner_id=m.owner_id
    WHERE m.owner_id=? AND m.role='user'
    AND (c.project_id IS NULL OR EXISTS(SELECT 1 FROM folders p WHERE p.id=c.project_id AND p.owner_id=m.owner_id))
    AND (json_extract(m.metadata,'$.personal')=1 OR (
      json_type(m.metadata,'$.personal') IS NULL
      AND json_type(m.metadata,'$.attachments')='array'
      AND json_type(m.metadata,'$.backend') IS NULL
      AND json_type(m.metadata,'$.sourceMessage') IS NULL
      AND r.kind='agent'
      AND NOT EXISTS(SELECT 1 FROM delegations d WHERE d.child_run_id=r.id)
    ))`;

// The owner is supplied by authentication, never by query parameters. Projects
// and conversations currently use this same ownership boundary (no memberships).
export function personalHistory(owner: string, before?: string, q?: string) {
  let cursor: [number, string] = [Number.MAX_SAFE_INTEGER, ""];
  if (before) {
    try {
      cursor = z
        .tuple([
          z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          z.string().min(1).max(150),
        ])
        .parse(JSON.parse(Buffer.from(before, "base64url").toString("utf8")));
    } catch {
      throw new Problem(400, "Invalid prompt cursor");
    }
  }
  const items = db
    .prepare(
      `${PROMPTS_WITH}
    SELECT m.id,m.content,m.created_at,m.conversation_id,
    json_extract(m.metadata,'$.attachments') attachments,c.title conversation_title,
    a.name agent_name,a.provider,a.id agent_id,project.name project_name
${PROMPTS_FROM}
    AND (? IS NULL OR instr(lower(m.content),lower(?))>0)
    AND (m.created_at,m.id)<(?,?)
    ORDER BY m.created_at DESC,m.id DESC LIMIT 51`,
    )
    .all(owner, q || null, q || null, ...cursor) as HistoryRow[];
  const more = items.length > 50;
  if (more) items.pop();
  const last = items.at(-1);
  return {
    items: items.map((item) => ({
      ...item,
      attachments: JSON.parse(item.attachments || "[]"),
    })),
    next:
      more && last
        ? Buffer.from(JSON.stringify([last.created_at, last.id])).toString(
            "base64url",
          )
        : null,
  };
}

/** How many prompts the owner has sent: the same set the list pages through. */
export function personalPromptCount(owner: string) {
  return (
    db
      .prepare(`${PROMPTS_WITH}\n    SELECT count(*) n\n${PROMPTS_FROM}`)
      .get(owner) as { n: number }
  ).n;
}
