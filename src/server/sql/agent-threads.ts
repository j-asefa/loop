import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const insertStatement = statement(
  "INSERT INTO agent_threads(id,owner_id,team_id,scope,subject,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
);
export function insert(
  db: Database.Database,
  id: string,
  owner: string,
  team: string | null,
  scope: string,
  subject: string,
  creator: string,
  created: number,
  updated: number,
) {
  return insertStatement(db).run(
    id,
    owner,
    team,
    scope,
    subject,
    creator,
    created,
    updated,
  );
}

const pauseStatement = statement(
  "UPDATE agent_threads SET paused_at=?,paused_reason=?,updated_at=? WHERE id=?",
);
export function pause(
  db: Database.Database,
  paused: number,
  reason: string,
  updated: number,
  thread: string,
) {
  return pauseStatement(db).run(paused, reason, updated, thread);
}

const pairResumeOrderStatement = statement(
  "SELECT max(t.resumed_order) at FROM agent_threads t WHERE t.owner_id=? AND EXISTS(SELECT 1 FROM agent_thread_members m WHERE m.thread_id=t.id AND m.agent_id=?) AND EXISTS(SELECT 1 FROM agent_thread_members m WHERE m.thread_id=t.id AND m.agent_id=?)",
);
const pairResumeOrderRow = z.object({ at: z.number().nullable() });
export function pairResumeOrder(
  db: Database.Database,
  owner: string,
  first: string,
  second: string,
) {
  const row = pairResumeOrderStatement(db).get(owner, first, second);
  return row === undefined
    ? undefined
    : parseRecord(pairResumeOrderRow, row, "agent_threads");
}

const touchStatement = statement(
  "UPDATE agent_threads SET updated_at=? WHERE id=?",
);
export function touch(db: Database.Database, updated: number, thread: string) {
  return touchStatement(db).run(updated, thread);
}

const ownedStatement = statement(
  "SELECT * FROM agent_threads WHERE id=? AND owner_id=?",
);
const ownedRow = QueryRecords.agent_threads;
export function owned(db: Database.Database, thread: string, owner: string) {
  const row = ownedStatement(db).get(thread, owner);
  return row === undefined
    ? undefined
    : parseRecord(ownedRow, row, "agent_threads");
}

const memberStatement = statement(
  "SELECT t.* FROM agent_threads t JOIN agent_thread_members m ON m.thread_id=t.id AND m.agent_id=? WHERE t.id=? AND t.owner_id=?",
);
const memberRow = QueryRecords.agent_threads;
export function member(
  db: Database.Database,
  agent: string | null,
  thread: string,
  owner: string,
) {
  const row = memberStatement(db).get(agent, thread, owner);
  return row === undefined
    ? undefined
    : parseRecord(memberRow, row, "agent_threads");
}

const ownerThreadStatement = statement(
  "SELECT * FROM agent_threads WHERE owner_id=? AND id=?",
);
const ownerThreadRow = QueryRecords.agent_threads;
export function ownerThread(
  db: Database.Database,
  owner: string,
  thread: string,
) {
  const row = ownerThreadStatement(db).get(owner, thread);
  return row === undefined
    ? undefined
    : parseRecord(ownerThreadRow, row, "agent_threads");
}

const memberScopeStatement = statement(
  "SELECT t.* FROM agent_threads t JOIN agent_thread_members m ON m.thread_id=t.id AND m.agent_id=? WHERE t.id=? AND t.owner_id=? AND (t.scope='direct' OR t.team_id=?)",
);
const memberScopeRow = QueryRecords.agent_threads;
export function memberScope(
  db: Database.Database,
  agent: string | null,
  thread: string,
  owner: string,
  team: string | null,
) {
  const row = memberScopeStatement(db).get(agent, thread, owner, team);
  return row === undefined
    ? undefined
    : parseRecord(memberScopeRow, row, "agent_threads");
}

const recentMemberScopeStatement = statement(
  "SELECT t.* FROM agent_threads t JOIN agent_thread_members m ON m.thread_id=t.id AND m.agent_id=? WHERE t.owner_id=? AND (t.scope='direct' OR t.team_id=?) ORDER BY t.updated_at DESC LIMIT 10",
);
const recentMemberScopeRow = QueryRecords.agent_threads;
export function recentMemberScope(
  db: Database.Database,
  agent: string | null,
  owner: string,
  team: string | null,
) {
  return recentMemberScopeStatement(db)
    .all(agent, owner, team)
    .map((row) => parseRecord(recentMemberScopeRow, row, "agent_threads"));
}

const getStatement = statement("SELECT * FROM agent_threads WHERE id=?");
const getRow = QueryRecords.agent_threads;
export function get(db: Database.Database, thread: string) {
  const row = getStatement(db).get(thread);
  return row === undefined
    ? undefined
    : parseRecord(getRow, row, "agent_threads");
}

const ownedTeamStatement = statement(
  "SELECT * FROM agent_threads WHERE id=@thread AND owner_id=@owner AND (@team IS NULL OR team_id=@team)",
);
const ownedTeamRow = QueryRecords.agent_threads;
export function ownedTeam(
  db: Database.Database,
  thread: string,
  owner: string,
  team: string | null,
) {
  const row = ownedTeamStatement(db).get({ thread, owner, team });
  return row === undefined
    ? undefined
    : parseRecord(ownedTeamRow, row, "agent_threads");
}

const resumeStatement = statement(
  "UPDATE agent_threads SET paused_at=NULL,paused_reason=NULL,resumed_at=@time,resumed_order=(SELECT COALESCE(max(rowid),0) FROM agent_mail),updated_at=@time WHERE id=@thread",
);
export function resume(db: Database.Database, time: number, thread: string) {
  return resumeStatement(db).run({ time, thread });
}

const resumeOrderStatement = statement(
  "SELECT resumed_order FROM agent_threads WHERE id=?",
);
const resumeOrderRow = QueryRecords.agent_threads.pick({ resumed_order: true });
export function resumeOrder(db: Database.Database, thread: string) {
  const row = resumeOrderStatement(db).get(thread);
  return row === undefined
    ? undefined
    : parseRecord(resumeOrderRow, row, "agent_threads");
}

const pauseAfterResumeStatement = statement(
  "UPDATE agent_threads SET paused_at=?,paused_reason=? WHERE id=?",
);
export function pauseAfterResume(
  db: Database.Database,
  paused: number,
  reason: string,
  thread: string,
) {
  return pauseAfterResumeStatement(db).run(paused, reason, thread);
}

const teamThreadsStatement = statement(
  "SELECT * FROM agent_threads WHERE owner_id=? AND team_id=? ORDER BY paused_at IS NULL,updated_at DESC LIMIT 30",
);
const teamThreadsRow = QueryRecords.agent_threads;
export function teamThreads(
  db: Database.Database,
  owner: string,
  team: string,
) {
  return teamThreadsStatement(db)
    .all(owner, team)
    .map((row) => parseRecord(teamThreadsRow, row, "agent_threads"));
}

const memberThreadsStatement = statement(
  "SELECT t.* FROM agent_threads t JOIN agent_thread_members m ON m.thread_id=t.id WHERE t.owner_id=? AND m.agent_id=? ORDER BY t.paused_at IS NULL,t.updated_at DESC,t.rowid DESC LIMIT 30",
);
const memberThreadsRow = QueryRecords.agent_threads;
export function memberThreads(
  db: Database.Database,
  owner: string,
  agent: string,
) {
  return memberThreadsStatement(db)
    .all(owner, agent)
    .map((row) => parseRecord(memberThreadsRow, row, "agent_threads"));
}

const hasMemberStatement = statement(
  "SELECT 1 FROM agent_threads t JOIN agent_thread_members m ON m.thread_id=t.id WHERE t.id=? AND t.owner_id=? AND m.agent_id=?",
);
const hasMemberRow = z.object({ "1": z.number() });
export function hasMember(
  db: Database.Database,
  thread: string,
  owner: string,
  agent: string,
) {
  const row = hasMemberStatement(db).get(thread, owner, agent);
  return row === undefined
    ? undefined
    : parseRecord(hasMemberRow, row, "agent_threads");
}

const scopeStatement = statement(
  "SELECT scope,team_id FROM agent_threads WHERE owner_id=? AND id=?",
);
const scopeRow = QueryRecords.agent_threads.pick({
  scope: true,
  team_id: true,
});
export function scope(db: Database.Database, owner: string, thread: string) {
  const row = scopeStatement(db).get(owner, thread);
  return row === undefined
    ? undefined
    : parseRecord(scopeRow, row, "agent_threads");
}

const advanceActivityStatement = statement(
  "UPDATE agent_threads SET updated_at=max(updated_at+1,?) WHERE owner_id=? AND id=?",
);
export function advanceActivity(
  db: Database.Database,
  updated: number,
  owner: string,
  thread: string,
) {
  return advanceActivityStatement(db).run(updated, owner, thread);
}

const feedStatement = statement(
  "\n      SELECT t.*,max(m.created_at) activity_at FROM agent_threads t\n      JOIN agent_mail m ON m.owner_id=t.owner_id AND m.thread_id=t.id\n      WHERE t.owner_id=@owner\n        AND (@view='threads' OR EXISTS(SELECT 1 FROM agent_mail sent WHERE sent.owner_id=@owner AND sent.thread_id=t.id AND sent.state='sent'))\n        AND EXISTS (\n          SELECT 1 FROM agent_mail linked\n          LEFT JOIN conversations c ON c.owner_id=linked.owner_id AND c.id IN (linked.sender_conversation_id,linked.recipient_conversation_id)\n          LEFT JOIN runs r ON r.owner_id=linked.owner_id AND r.id IN (\n            CASE WHEN c.id=linked.sender_conversation_id THEN linked.sender_run_id END,\n            CASE WHEN c.id=linked.recipient_conversation_id THEN COALESCE(linked.requeued_run_id,linked.run_id) END\n          )\n          LEFT JOIN teams team ON team.owner_id=linked.owner_id AND team.deleted_at IS NULL\n            AND team.id=CASE WHEN t.scope='team' THEN t.team_id ELSE c.team_id END\n          WHERE linked.owner_id=@owner AND linked.thread_id=t.id\n            AND (@agent IS NULL OR @agent IN (linked.sender_agent_id,linked.recipient_agent_id))\n            AND (@teams IS NULL OR team.id IN (SELECT value FROM json_each(@teams)))\n            AND (@agent IS NOT NULL OR @teams IS NOT NULL OR NOT COALESCE(team.hide_results_from_feed,0))\n            AND (@folders IS NULL OR EXISTS (\n              SELECT 1 FROM json_each(@folders) folder WHERE\n                c.id IS NOT NULL AND folder.value IS CASE WHEN json_type(r.payload,'$.folderId') IS NOT NULL THEN json_extract(r.payload,'$.folderId') ELSE c.project_id END\n            ))\n        )\n      GROUP BY t.id\n      HAVING @at IS NULL OR (activity_at,t.id)<(@at,@id)\n      ORDER BY activity_at DESC,t.id DESC LIMIT @limit\n    ",
);
const feedRow = QueryRecords.agent_threads.extend({ activity_at: z.number() });
export function feed(
  db: Database.Database,
  options: {
    owner: string;
    agent: string | null;
    teams: string | null;
    folders: string | null;
    view: string;
    at: number | null;
    id: string | null;
    limit: number;
  },
) {
  return feedStatement(db)
    .all(options)
    .map((row) => parseRecord(feedRow, row, "agent_threads"));
}

const visibleOwnedStatement = statement(
  "SELECT * FROM agent_threads WHERE owner_id=@owner AND id=@thread AND EXISTS(SELECT 1 FROM agent_mail WHERE owner_id=@owner AND thread_id=@thread)",
);
const visibleOwnedRow = QueryRecords.agent_threads;
export function visibleOwned(
  db: Database.Database,
  owner: string,
  thread: string,
) {
  const row = visibleOwnedStatement(db).get({ owner, thread });
  return row === undefined
    ? undefined
    : parseRecord(visibleOwnedRow, row, "agent_threads");
}

const mailScopeStatement = statement(
  "SELECT t.scope FROM agent_threads t JOIN agent_mail m ON m.thread_id=t.id WHERE m.owner_id=? AND m.idempotency_key=?",
);
const mailScopeRow = QueryRecords.agent_threads.pick({ scope: true });
export function mailScope(db: Database.Database, owner: string, key: string) {
  const row = mailScopeStatement(db).get(owner, key);
  return row === undefined
    ? undefined
    : parseRecord(mailScopeRow, row, "agent_threads");
}

const ownedScopeStatement = statement(
  "SELECT scope FROM agent_threads WHERE id=? AND owner_id=?",
);
const ownedScopeRow = QueryRecords.agent_threads.pick({ scope: true });
export function ownedScope(
  db: Database.Database,
  thread: string,
  owner: string,
) {
  const row = ownedScopeStatement(db).get(thread, owner);
  return row === undefined
    ? undefined
    : parseRecord(ownedScopeRow, row, "agent_threads");
}

const pausedCountStatement = statement(
  "SELECT count(*) n FROM agent_threads WHERE owner_id=? AND team_id=? AND paused_at IS NOT NULL",
);
const pausedCountRow = z.object({ n: z.number() });
export function pausedCount(
  db: Database.Database,
  owner: string,
  team: string,
) {
  const row = pausedCountStatement(db).get(owner, team);
  return row === undefined
    ? undefined
    : parseRecord(pausedCountRow, row, "agent_threads");
}
