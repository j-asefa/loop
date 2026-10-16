import { randomUUID } from "node:crypto";

/** A saved Git observation for browser fixtures; never reads a real checkout. */
export function seedCheckout(db, runId, { files, patch = "" }) {
  const run = db.prepare("SELECT * FROM runs WHERE id=?").get(runId);
  const summary = {
    id: randomUUID(), state: "captured", scope: "run", branch: "feature/settings",
    base_ref: "run start", ahead: 1, behind: 0, files: files.length,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    untracked: 0, remote: "none", started_dirty: false, overlap: 0, late: false, error: null,
  };
  db.prepare(`INSERT INTO run_checkouts(
    id,owner_id,run_id,agent_id,conversation_id,directory,source,branch,base_ref,base_sha,
    start_head,start_patch,start_untracked_paths,start_dirty,start_untracked,started_at,
    state,end_head,ahead,behind,files,untracked,patch,patch_bytes,patch_truncated,overlap,summary,ended_at
  ) VALUES(
    @id,@owner,@run,@agent,@conversation,'/work/site','/work/site',@branch,'run start',@start,
    @start,'','[]',0,0,@started,'captured',@end,1,0,@files,'[]',@patch,@bytes,0,'[]',@summary,@ended
  )`).run({
    id: summary.id, owner: run.owner_id, run: runId, agent: run.agent_id,
    conversation: run.conversation_id, branch: summary.branch,
    start: "a".repeat(40), end: "b".repeat(40), started: run.created_at,
    ended: run.updated_at, files: JSON.stringify(files), patch, bytes: Buffer.byteLength(patch),
    summary: JSON.stringify(summary),
  });
  return summary;
}
