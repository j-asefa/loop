import * as artifactsQueries from "./sql/artifacts.js";
import * as conversationPullLinksQueries from "./sql/conversation-pull-links.js";
import * as messagesQueries from "./sql/messages.js";
import * as watchQueries from "./sql/pr-watches.js";
import { db, now } from "./db.js";
import { ownedConversation, Problem } from "./domain.js";
import type { Run } from "./queue.js";
import { githubTokens } from "./github-api.js";
import { pullSummary } from "./github-pulls.js";
import {
  parsePullRequestUrls,
  pullRequestKey,
  type PullRequestRef,
} from "../shared/github.js";
import type { ConversationPulls } from "../shared/conversation-pulls.js";

/** A confirmed create result is enough to retain the link, even offline. */
export function linkCreatedPullRequest(run: Run, ref: PullRequestRef) {
  if (!run.conversation_id) return;
  conversationPullLinksQueries.insertOwned(
    db,
    run.owner_id,
    run.conversation_id,
    ref.owner,
    ref.repo,
    ref.number,
    now(),
    run.conversation_id,
    run.owner_id,
  );
}

/** Explicit references only: never guess from an agent's mutable checkout. */
function conversationPullRefs(owner: string, conversation: string) {
  ownedConversation(conversation, owner);
  const refs = new Map<
    string,
    { ref: PullRequestRef; at: number; creation: boolean }
  >();
  const add = (ref: PullRequestRef, at: number, creation = false) => {
    const key = pullRequestKey(ref).toLowerCase(),
      previous = refs.get(key);
    if (!previous || at > previous.at || (at === previous.at && creation))
      refs.set(key, { ref, at, creation });
  };
  // Collect the newest distinct candidates independently from each source,
  // so old transcript links cannot crowd out newer saved PR cards.
  // Tool output alone is not evidence that a thread is working on that PR.
  for (const read of [
    () => messagesQueries.pullReferences(db, owner, conversation),
    () => artifactsQueries.pullReferences(db, owner, conversation),
  ]) {
    const candidates = new Set<string>();
    for (const row of read()) {
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
  for (const row of watchQueries.createdPulls(
    db,
    owner,
    conversation,
    owner,
    conversation,
  )) {
    add(
      { owner: row.owner, repo: row.repo, number: row.number },
      row.created_at,
      true,
    );
    createdCandidates.add(pullRequestKey(row).toLowerCase());
    if (createdCandidates.size > 20) break;
  }
  return {
    refs: [...refs.values()]
      .sort((a, b) => b.at - a.at || Number(b.creation) - Number(a.creation))
      .slice(0, 20)
      .map((item) => item.ref),
    hasMore: refs.size > 20,
  };
}

/** Display reads never start a watch or send an agent a follow-up. */
export async function conversationPulls(
  owner: string,
  conversation: string,
  refresh = false,
): Promise<ConversationPulls> {
  const { refs, hasMore } = conversationPullRefs(owner, conversation);
  const connected = githubTokens(owner).length > 0;
  if (!connected) return { connected, pulls: refs, hasMore };
  const pulls: ConversationPulls["pulls"] = [];
  // Bound concurrent GitHub reads, while retaining independent errors/links.
  for (let offset = 0; offset < refs.length; offset += 3) {
    pulls.push(
      ...(await Promise.all(
        refs.slice(offset, offset + 3).map(async (ref) => {
          try {
            return await pullSummary(owner, ref, refresh);
          } catch (error) {
            return {
              ...ref,
              error:
                error instanceof Problem
                  ? error.message
                  : "Could not refresh this pull request.",
            };
          }
        }),
      )),
    );
  }
  return { connected, pulls, hasMore };
}
