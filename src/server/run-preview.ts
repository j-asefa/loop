import type Database from "better-sqlite3";
import * as agentCheckpointsQueries from "./sql/agent-checkpoints.js";
import * as messagesQueries from "./sql/messages.js";
/**
 * What a run has produced so far: its result artifact, if one exists, and
 * the newest public update when the artifact has no content yet.
 */
export function runPreview(
  db: Database.Database,
  owner: string,
  runId: string,
) {
  const artifact = agentCheckpointsQueries.result(db, owner, runId);
  const latest = !artifact?.content
    ? messagesQueries.latestAssistantContent(db, owner, runId)?.content
    : undefined;
  if (artifact && latest) artifact.content = latest;
  return { latest, artifact: artifact || null };
}
