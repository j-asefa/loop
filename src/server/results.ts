import * as projectChangeFoldersQueries from "./sql/project-change-folders.js";
import * as foldersQueries from "./sql/folders.js";
import * as feedRevisionQueries from "./sql/feed-revisions.js";
import { db } from "./db.js";
import { isWorkspaceProject } from "./workspace-project.js";

export function projectFolders(
  owner: string,
  project: string,
): (string | null)[] {
  if (isWorkspaceProject(owner, project))
    return (
      projectChangeFoldersQueries.forProject(db, owner, project) as {
        folder_id: string | null;
      }[]
    ).map((row) => row.folder_id);
  return (
    foldersQueries.descendants(db, owner, project, owner) as { id: string }[]
  ).map((row) => row.id);
}

export {
  traceArtifactSql,
  finishedArtifactSql,
  fileArtifactSql,
  resultOutputSql,
} from "./sql/artifacts.js";

export function resultsRevision(owner: string) {
  return feedRevisionQueries.revision(db, owner);
}

export function resultsUpdates(
  owner: string,
  options: {
    after: number;
    through: number;
    agent?: string;
    folder?: string;
    view?: string;
    teams?: string[];
    saved?: boolean;
  },
) {
  // Capture the watermark before reading: a later concurrent write will be
  // replayed next time, never skipped because its revision was acknowledged early.
  const revision = resultsRevision(owner);
  const prompts = !options.saved && options.view === "prompts";
  const folders = options.folder
    ? new Set(projectFolders(owner, options.folder))
    : null;
  const rows = feedRevisionQueries.updates(
    db,
    owner,
    options,
    revision,
  ) as any[];
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
      change_revision: _revision,
      changed_id,
      feed_agent_id,
      output_visible,
      ...item
    } = row;
    const visible =
      item.id &&
      (prompts
        ? item.role === "user"
        : !item.archived &&
          (options.saved ? item.pinned : !item.feed_hidden) &&
          output_visible) &&
      (!options.teams?.length || options.teams.includes(item.team_id)) &&
      (!folders || folders.has(item.folder_id)) &&
      (!options.agent ||
        (prompts ? feed_agent_id : item.agent_id) === options.agent) &&
      (options.saved || options.view !== "files" || fileKinds.has(item.kind));
    if (visible)
      items.push(prompts ? { ...item, agent_id: feed_agent_id } : item);
    else removed.push(changed_id);
  }
  return {
    items,
    removed,
    revision: rows.length === 200 ? rows.at(-1)!.change_revision : revision,
    more: rows.length === 200,
  };
}

/**
 * Where a result opens: its thread at the answer that produced it, so a
 * notification or reminder lands on the message. A result with no thread
 * opens on its own.
 */
export function resultUrl(result: {
  id: string;
  conversation_id: string | null;
  message_id?: string | null;
}) {
  if (!result.conversation_id)
    return "/?artifact=" + encodeURIComponent(result.id);
  return (
    "/?conversation=" +
    encodeURIComponent(result.conversation_id) +
    (result.message_id
      ? "&message=" + encodeURIComponent(result.message_id)
      : "")
  );
}
