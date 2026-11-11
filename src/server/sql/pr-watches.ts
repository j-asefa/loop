import {
  DONE_CARD_PREFIX,
  IDLE_DONE_KEY_PREFIX,
} from "../../shared/done-card-id.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const statusRow = QueryRecords.pr_watches.pick({
  repo_owner: true,
  repo_name: true,
  number: true,
  state: true,
  ended_reason: true,
  error: true,
  head_sha: true,
  ci_sha: true,
  ci_conclusion: true,
  ci_pending: true,
  read_at: true,
  seen_ci_sha: true,
  seen_ci_conclusion: true,
});
const listRow = QueryRecords.pr_watches.pick({
  repo_owner: true,
  repo_name: true,
  number: true,
  state: true,
  ended_reason: true,
  error: true,
  head_sha: true,
  ci_sha: true,
  ci_conclusion: true,
  ci_pending: true,
  read_at: true,
  seen_ci_sha: true,
  seen_ci_conclusion: true,
  id: true,
  conversation_id: true,
  agent_id: true,
  created_at: true,
  updated_at: true,
});

const listStatement =
  statement(`SELECT id,conversation_id,agent_id,repo_owner,repo_name,number,state,ended_reason,error,head_sha,ci_sha,ci_conclusion,ci_pending,read_at,seen_ci_sha,seen_ci_conclusion,created_at,updated_at
      FROM pr_watches WHERE owner_id=@owner AND (@conversation IS NULL OR conversation_id=@conversation)
        AND (state IN ('watching','paused') OR updated_at>@since)
      ORDER BY CASE state WHEN 'watching' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, created_at DESC LIMIT 100`);
export function list(
  db: Database.Database,
  owner: string,
  conversation: string | null,
  since: number,
) {
  return listStatement(db)
    .all({ owner, conversation, since })
    .map((row) => parseRecord(listRow, row, "pr_watches"));
}

const pullStatusStatement =
  statement(`SELECT repo_owner,repo_name,number,state,ended_reason,error,head_sha,ci_sha,ci_conclusion,ci_pending,read_at,seen_ci_sha,seen_ci_conclusion
       FROM pr_watches WHERE owner_id=? AND conversation_id=?
         AND (state IN ('watching','paused') OR updated_at>?)
       ORDER BY CASE state WHEN 'watching' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, created_at DESC LIMIT 1`);
const pullStatusRow = statusRow;
export function pullStatus(
  db: Database.Database,
  owner: string,
  conversation: string,
  since: number,
) {
  const row = pullStatusStatement(db).get(owner, conversation, since);
  return row === undefined
    ? undefined
    : parseRecord(pullStatusRow, row, "pr_watches");
}

const latestForPullStatement = statement(
  "SELECT * FROM pr_watches WHERE owner_id=? AND conversation_id=? AND lower(repo_owner)=lower(?) AND lower(repo_name)=lower(?) AND number=? ORDER BY created_at DESC LIMIT 1",
);

export function latestForPull(
  db: Database.Database,
  owner: string,
  conversation: string,
  repoOwner: string,
  repoName: string,
  number: number,
) {
  const row = latestForPullStatement(db).get(
    owner,
    conversation,
    repoOwner,
    repoName,
    number,
  );
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.pr_watches, row, "pr_watches");
}

const insertStatement = statement(
  "INSERT INTO pr_watches(id,owner_id,conversation_id,agent_id,repo_owner,repo_name,number,state,head_sha,since_at,next_poll_at,created_at,updated_at) VALUES(@id,@owner,@conversation,@agent,@repoOwner,@repoName,@number,'watching',@head,@since,0,@created,@created)",
);
export function insert(
  db: Database.Database,
  id: string,
  owner: string,
  conversation: string,
  agent: string,
  repoOwner: string,
  repoName: string,
  number: number,
  head: string | null,
  since: number,
  created: number,
) {
  return insertStatement(db).run({
    id,
    owner,
    conversation,
    agent,
    repoOwner,
    repoName,
    number,
    head,
    since,
    created,
  });
}

const getStatement = statement("SELECT * FROM pr_watches WHERE id=?");

export function get(db: Database.Database, id: string) {
  const row = getStatement(db).get(id);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.pr_watches, row, "pr_watches");
}

const activeForPullStatement = statement(
  "SELECT * FROM pr_watches WHERE owner_id=? AND conversation_id=? AND lower(repo_owner)=lower(?) AND lower(repo_name)=lower(?) AND number=? AND state IN ('watching','paused')",
);

export function activeForPull(
  db: Database.Database,
  owner: string,
  conversation: string,
  repoOwner: string,
  repoName: string,
  number: number,
) {
  const row = activeForPullStatement(db).get(
    owner,
    conversation,
    repoOwner,
    repoName,
    number,
  );
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.pr_watches, row, "pr_watches");
}

const ownedStatement = statement(
  "SELECT * FROM pr_watches WHERE id=? AND owner_id=?",
);

export function owned(db: Database.Database, id: string, owner: string) {
  const row = ownedStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.pr_watches, row, "pr_watches");
}

const resumeStatement = statement(
  "UPDATE pr_watches SET state='watching',error=NULL,next_poll_at=0,updated_at=? WHERE id=? AND state='paused'",
);
export function resume(db: Database.Database, updated: number, id: string) {
  return resumeStatement(db).run(updated, id);
}

const endStatement = statement(
  "UPDATE pr_watches SET state='stopped',ended_reason=?,updated_at=? WHERE id=? AND state<>'stopped'",
);
export function end(
  db: Database.Database,
  reason: string,
  updated: number,
  id: string,
) {
  return endStatement(db).run(reason, updated, id);
}

const pauseStatement = statement(
  "UPDATE pr_watches SET state='paused',error=?,updated_at=? WHERE id=? AND state='watching'",
);
export function pause(
  db: Database.Database,
  reason: string,
  updated: number,
  id: string,
) {
  return pauseStatement(db).run(reason, updated, id);
}

const watchingStatement = statement(
  "SELECT * FROM pr_watches WHERE id=? AND state='watching'",
);

export function watching(db: Database.Database, id: string) {
  const row = watchingStatement(db).get(id);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.pr_watches, row, "pr_watches");
}

const scheduleStatement = statement(
  "UPDATE pr_watches SET next_poll_at=? WHERE id=?",
);
export function schedule(db: Database.Database, nextPoll: number, id: string) {
  return scheduleStatement(db).run(nextPoll, id);
}

const retryStatement = statement(
  "UPDATE pr_watches SET error=?,next_poll_at=?,updated_at=? WHERE id=? AND state='watching'",
);
export function retry(
  db: Database.Database,
  error: string,
  nextPoll: number,
  updated: number,
  id: string,
) {
  return retryStatement(db).run(error, nextPoll, updated, id);
}

const notStoppedStatement = statement(
  "SELECT 1 FROM pr_watches WHERE id=? AND state<>'stopped'",
);
const notStoppedRow = z.object({ "1": z.number() });
export function notStopped(db: Database.Database, id: string) {
  const row = notStoppedStatement(db).get(id);
  return row === undefined
    ? undefined
    : parseRecord(notStoppedRow, row, "pr_watches");
}

const advanceStatement =
  statement(`UPDATE pr_watches SET login=@login,head_sha=@head,
            ci_sha=COALESCE(@ciSha,ci_sha),ci_conclusion=COALESCE(@ciConclusion,ci_conclusion),
            seen_ci_sha=COALESCE(@ciSha,seen_ci_sha),seen_ci_conclusion=COALESCE(@ciConclusion,seen_ci_conclusion),
            ci_pending=@pending,read_at=@read,error=NULL,updated_at=@updated WHERE id=@id`);
export function advance(
  db: Database.Database,
  login: string | null,
  head: string,
  ciSha: string | null,
  ciConclusion: string | null,
  pending: number,
  read: number,
  updated: number,
  id: string,
) {
  return advanceStatement(db).run({
    login,
    head,
    ciSha,
    ciConclusion,
    pending,
    read,
    updated,
    id,
  });
}

const observeStatement = statement(
  "UPDATE pr_watches SET head_sha=?,seen_ci_sha=COALESCE(?,seen_ci_sha),seen_ci_conclusion=COALESCE(?,seen_ci_conclusion),ci_pending=?,read_at=? WHERE id=?",
);
export function observe(
  db: Database.Database,
  head: string,
  seenSha: string | null,
  seenConclusion: string | null,
  pending: number,
  read: number,
  id: string,
) {
  return observeStatement(db).run(
    head,
    seenSha,
    seenConclusion,
    pending,
    read,
    id,
  );
}

const dueStatement = statement(
  "SELECT id FROM pr_watches WHERE state='watching' AND next_poll_at<=? ORDER BY next_poll_at LIMIT 20",
);
const dueRow = QueryRecords.pr_watches.pick({ id: true });
export function due(db: Database.Database, time: number) {
  return dueStatement(db)
    .all(time)
    .map((row) => parseRecord(dueRow, row, "pr_watches"));
}

const claimStatement = statement(
  "UPDATE pr_watches SET next_poll_at=? WHERE id=? AND state='watching' AND next_poll_at<=?",
);
export function claim(
  db: Database.Database,
  nextPoll: number,
  id: string,
  time: number,
) {
  return claimStatement(db).run(nextPoll, id, time);
}

const expiredCardsStatement = statement(`WITH expired_watches AS (
      SELECT conversation_id,updated_at+604800000 at FROM pr_watches
      WHERE owner_id=@owner AND state='stopped' AND updated_at+604800000>=@afterAt
        AND updated_at+604800000<=@now
    ), expiries AS (
      SELECT approval_until at,
        '${DONE_CARD_PREFIX}'||COALESCE(NULLIF(card_key,''),'${IDLE_DONE_KEY_PREFIX}'||conversation_id) key
      FROM feed_cards WHERE owner_id=@owner AND kind='thread' AND approval_until>=@afterAt AND approval_until<=@now
      UNION SELECT w.at,'${DONE_CARD_PREFIX}run:'||r.id FROM expired_watches w JOIN runs r
        ON r.conversation_id=w.conversation_id AND r.owner_id=@owner
      UNION SELECT w.at,'${DONE_CARD_PREFIX}message:'||m.id FROM expired_watches w JOIN messages m
        ON m.conversation_id=w.conversation_id AND m.owner_id=@owner
      UNION SELECT w.at,'${DONE_CARD_PREFIX}${IDLE_DONE_KEY_PREFIX}'||w.conversation_id FROM expired_watches w
    ) SELECT key id,at,key FROM expiries WHERE (at,key)>(@afterAt,@afterId)
      ORDER BY at,key LIMIT @limit`);
const expiredCardsRow = z.object({
  id: z.string(),
  at: z.number(),
  key: z.string(),
});
export function expiredCards(
  db: Database.Database,
  bindings: {
    owner: string;
    afterAt: number;
    afterId: string;
    now: number;
    limit: number;
  },
) {
  return expiredCardsStatement(db)
    .all(bindings)
    .map((row) => parseRecord(expiredCardsRow, row, "pr_watches"));
}

const createdPullsStatement =
  statement(`SELECT repo_owner owner,repo_name repo,number,created_at FROM (
    SELECT repo_owner,repo_name,number,created_at FROM conversation_pull_links WHERE owner_id=@owner AND conversation_id=@conversation
    UNION ALL SELECT repo_owner,repo_name,number,created_at FROM pr_watches WHERE owner_id=@owner AND conversation_id=@conversation
  ) ORDER BY created_at DESC`);
const createdPullsRow = z.object({
  owner: z.string(),
  repo: z.string(),
  number: z.number(),
  created_at: z.number(),
});
export function* createdPulls(
  db: Database.Database,
  owner: string,
  conversation: string,
) {
  for (const row of createdPullsStatement(db).iterate({ owner, conversation }))
    yield parseRecord(createdPullsRow, row, "pr_watches");
}

const threadDetailsStatement =
  statement(`SELECT repo_owner,repo_name,number,state,ended_reason,error,head_sha,ci_sha,ci_conclusion,
    ci_pending,read_at,seen_ci_sha,seen_ci_conclusion,updated_at,created_at FROM pr_watches WHERE owner_id=? AND conversation_id=?
    ORDER BY CASE state WHEN 'watching' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,created_at DESC`);
const threadDetailsRow = statusRow.extend({
  updated_at: z.number(),
  created_at: z.number(),
});
export function threadDetails(
  db: Database.Database,
  owner: string,
  conversation: string,
) {
  return threadDetailsStatement(db)
    .all(owner, conversation)
    .map((row) => parseRecord(threadDetailsRow, row, "pr_watches"));
}
