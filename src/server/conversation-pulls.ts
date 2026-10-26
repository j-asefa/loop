import { db, now } from "./db.js";
import { ownedConversation, Problem } from "./domain.js";
import type { Run } from "./queue.js";
import { githubTokens } from "./github-api.js";
import { pullSummary } from "./github-pulls.js";
import { parsePullRequestUrls, pullRequestKey, type PullRequestRef } from "../shared/github.js";
import type { ConversationPulls } from "../shared/conversation-pulls.js";

/** A confirmed create result is enough to retain the link, even offline. */
export function linkCreatedPullRequest(run: Run, ref: PullRequestRef) {
  if (!run.conversation_id) return;
  db.prepare(`INSERT OR IGNORE INTO conversation_pull_links
    (owner_id,conversation_id,repo_owner,repo_name,number,created_at)
    SELECT ?,?,?,?,?,? WHERE EXISTS (
      SELECT 1 FROM conversations WHERE id=? AND owner_id=?)`)
    .run(run.owner_id, run.conversation_id, ref.owner, ref.repo, ref.number, now(),
      run.conversation_id, run.owner_id);
}

/** Explicit references only: never guess from an agent's mutable checkout. */
export function conversationPullRefs(owner: string, conversation: string) {
  ownedConversation(conversation, owner);
  const refs = new Map<string, { ref: PullRequestRef; at: number; creation: boolean }>();
  const add = (ref: PullRequestRef, at: number, creation = false) => {
    const key = pullRequestKey(ref).toLowerCase(), previous = refs.get(key);
    if (!previous || at > previous.at || (at === previous.at && creation))
      refs.set(key, { ref, at, creation });
  };
  // Collect the newest distinct candidates independently from each source,
  // so old transcript links cannot crowd out newer saved PR cards.
  // Tool output alone is not evidence that a thread is working on that PR.
  for (const query of [`SELECT content,created_at FROM messages
    WHERE owner_id=? AND conversation_id=? AND role IN ('user','assistant')
      AND instr(content,'github.com/')>0 ORDER BY created_at DESC,rowid DESC`,
    `SELECT content,created_at FROM artifacts
    WHERE owner_id=? AND conversation_id=? AND kind='github_pr'
    ORDER BY created_at DESC,rowid DESC`]) {
    const candidates = new Set<string>();
    for (const row of db.prepare(query).iterate(owner, conversation) as Iterable<{ content: string; created_at: number }>) {
      for (const ref of parsePullRequestUrls(row.content, 21)) {
        add(ref, row.created_at);
        candidates.add(pullRequestKey(ref).toLowerCase());
      }
      if (candidates.size > 20) break;
    }
  }
  // Keep confirmed creations and old watches even when watching ends, pauses,
  // is unavailable, or the agent omitted the URL from its final answer.
  const createdCandidates = new Set<string>();
  for (const row of db.prepare(`SELECT repo_owner owner,repo_name repo,number,created_at FROM (
    SELECT repo_owner,repo_name,number,created_at FROM conversation_pull_links WHERE owner_id=? AND conversation_id=?
    UNION ALL SELECT repo_owner,repo_name,number,created_at FROM pr_watches WHERE owner_id=? AND conversation_id=?
  ) ORDER BY created_at DESC`).iterate(owner, conversation, owner, conversation) as Iterable<PullRequestRef & { created_at: number }>) {
    add({ owner: row.owner, repo: row.repo, number: row.number }, row.created_at, true);
    createdCandidates.add(pullRequestKey(row).toLowerCase());
    if (createdCandidates.size > 20) break;
  }
  return {
    refs: [...refs.values()].sort((a, b) => b.at - a.at || Number(b.creation) - Number(a.creation))
      .slice(0, 20).map(item => item.ref),
    hasMore: refs.size > 20,
  };
}

/** Display reads never start a watch or send an agent a follow-up. */
export async function conversationPulls(owner: string, conversation: string, refresh = false): Promise<ConversationPulls> {
  const { refs, hasMore } = conversationPullRefs(owner, conversation);
  const connected = githubTokens(owner).length > 0;
  if (!connected) return { connected, pulls: refs, hasMore };
  const pulls: ConversationPulls["pulls"] = [];
  // Bound concurrent GitHub reads, while retaining independent errors/links.
  for (let offset = 0; offset < refs.length; offset += 3) {
    pulls.push(...await Promise.all(refs.slice(offset, offset + 3).map(async ref => {
      try { return await pullSummary(owner, ref, refresh); }
      catch (error) {
        return { ...ref, error: error instanceof Problem ? error.message : "Could not refresh this pull request." };
      }
    })));
  }
  return { connected, pulls, hasMore };
}
