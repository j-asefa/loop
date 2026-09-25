import { db } from "./db.js";

// The same rule must govern initial pages and update tombstones. A running or
// failed placeholder is not an output, and tool artifacts belong to Traces.
export const traceArtifactSql = `(json_extract(a.metadata,'$.tool') IS NOT NULL
  OR json_extract(a.metadata,'$.native')=1
  OR EXISTS(SELECT 1 FROM agent_checkpoints cp WHERE cp.run_id=a.run_id AND cp.artifact_id<>a.id))`;
export const finishedArtifactSql = `(a.run_id IS NULL OR r.state='completed')`;
export const feedOutputSql = `${finishedArtifactSql} AND NOT COALESCE(${traceArtifactSql},0)
  AND COALESCE(json_extract(a.metadata,'$.partial'),0)=0`;

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
    teams?: string[];
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
    SELECT f.revision,f.object_id AS changed_id,f.cursor,m.*,r.state run_state,r.error run_error,c.agent_id AS feed_agent_id,c.team_id,g.name,g.provider
    FROM feed_revisions f LEFT JOIN messages m ON m.id=f.object_id AND m.owner_id=f.owner_id
    LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id
    LEFT JOIN conversations c ON c.id=m.conversation_id LEFT JOIN agents g ON g.id=c.agent_id
    WHERE f.owner_id=? AND f.entity='prompt' AND f.revision>? AND f.revision<=? AND f.cursor>=?
    ORDER BY f.revision LIMIT 200
  `
        : `
    SELECT f.revision,f.object_id AS changed_id,COALESCE(p.sequence,f.cursor) AS cursor,a.*,r.state run_state,r.error run_error,json_remove(a.metadata,'$.appResource.html','$.toolResult') AS metadata,g.name,g.provider,c.team_id,(${options.view === "files" ? finishedArtifactSql : feedOutputSql}) AS output_visible
    FROM feed_revisions f LEFT JOIN artifacts a ON a.id=f.object_id AND a.owner_id=f.owner_id
    LEFT JOIN artifact_publications p ON p.artifact_id=f.object_id
    LEFT JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id
    LEFT JOIN agents g ON g.id=a.agent_id LEFT JOIN conversations c ON c.id=a.conversation_id
    WHERE f.owner_id=? AND f.entity='artifact' AND f.revision>? AND f.revision<=? AND (p.sequence>=? OR p.sequence IS NULL)
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
    const {
      revision: _revision,
      changed_id,
      feed_agent_id,
      output_visible,
      ...item
    } = row;
    const visible =
      item.id &&
      (prompts
        ? item.role === "user"
        : !item.archived && !item.feed_hidden && output_visible) &&
      (!options.teams?.length || options.teams.includes(item.team_id)) &&
      (!options.agent ||
        (prompts ? feed_agent_id : item.agent_id) === options.agent) &&
      (options.view !== "files" || fileKinds.has(item.kind));
    if (visible)
      items.push(prompts ? { ...item, agent_id: feed_agent_id } : item);
    else removed.push(changed_id);
  }
  return {
    items,
    removed,
    revision: rows.length === 200 ? rows.at(-1)!.revision : revision,
    more: rows.length === 200,
  };
}
