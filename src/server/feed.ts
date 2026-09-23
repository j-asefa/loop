import { db } from "./db.js";

export function feedRevision(owner: string) {
  return (
    db
      .prepare(
        "SELECT COALESCE(max(revision),0) revision FROM feed_revisions WHERE owner_id=?",
      )
      .get(owner) as { revision: number }
  ).revision;
}

export function feedUpdates(
  owner: string,
  options: {
    after: number;
    through: number;
    agent?: string;
    view?: string;
  },
) {
  // Capture the watermark before reading: a later concurrent write will be
  // replayed next time, never skipped because its revision was acknowledged early.
  const revision = feedRevision(owner);
  const prompts = options.view === "prompts";
  const rows = db
    .prepare(
      prompts
        ? `
    SELECT f.revision,f.object_id AS changed_id,f.cursor,m.*,c.agent_id AS feed_agent_id,g.name,g.provider
    FROM feed_revisions f LEFT JOIN messages m ON m.id=f.object_id AND m.owner_id=f.owner_id
    LEFT JOIN conversations c ON c.id=m.conversation_id LEFT JOIN agents g ON g.id=c.agent_id
    WHERE f.owner_id=? AND f.entity='prompt' AND f.revision>? AND f.revision<=? AND f.cursor>=?
    ORDER BY f.revision LIMIT 200
  `
        : `
    SELECT f.revision,f.object_id AS changed_id,f.cursor,a.*,json_remove(a.metadata,'$.appResource.html','$.toolResult') AS metadata,g.name,g.provider
    FROM feed_revisions f LEFT JOIN artifacts a ON a.id=f.object_id AND a.owner_id=f.owner_id
    LEFT JOIN agents g ON g.id=a.agent_id
    WHERE f.owner_id=? AND f.entity='artifact' AND f.revision>? AND f.revision<=? AND f.cursor>=?
    ORDER BY f.revision LIMIT 200
  `,
    )
    .all(owner, options.after, revision, options.through) as any[];
  const items = [],
    removed: string[] = [];
  const fileKinds = new Set([
    "file",
    "image",
    "code",
    "table",
    "diagram",
    "chart",
    "workflow",
  ]);
  for (const row of rows) {
    const { revision: _revision, changed_id, feed_agent_id, ...item } = row;
    const visible =
      item.id &&
      (prompts ? item.role === "user" : !item.archived) &&
      (!options.agent ||
        (prompts ? feed_agent_id : item.agent_id) === options.agent) &&
      (options.view !== "files" || fileKinds.has(item.kind));
    if (visible) items.push(item);
    else removed.push(changed_id);
  }
  return {
    items,
    removed,
    revision: rows.length === 200 ? rows.at(-1)!.revision : revision,
    more: rows.length === 200,
  };
}
