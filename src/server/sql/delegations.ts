import { ACTIVE } from "./runs.js";
const FINISHED = "('completed','failed','cancelled','interrupted')";
import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const countStatement = statement(
  "SELECT count(*) n FROM delegations WHERE parent_run_id=?",
);
const countRow = z.object({ n: z.number() });
export function count(db: Database.Database, parent: string) {
  const row = countStatement(db).get(parent);
  return row === undefined
    ? undefined
    : parseRecord(countRow, row, "delegations");
}

const callChildrenStatement = statement(
  "SELECT d.*,r.state,r.result,r.error,r.agent_id,r.id FROM delegations d JOIN runs r ON r.id=d.child_run_id WHERE d.parent_run_id=? AND substr(d.call_id,1,?)=?",
);
const callChildrenRow = QueryRecords.delegations.extend({
  state: QueryRecords.runs.shape.state,
  result: QueryRecords.runs.shape.result,
  error: QueryRecords.runs.shape.error,
  agent_id: QueryRecords.runs.shape.agent_id,
  id: QueryRecords.runs.shape.id,
});
export function callChildren(
  db: Database.Database,
  parent: string,
  prefixLength: number,
  prefix: string,
) {
  return callChildrenStatement(db)
    .all(parent, prefixLength, prefix)
    .map((row) => parseRecord(callChildrenRow, row, "delegations"));
}

const insertStatement = statement(
  "INSERT INTO delegations(parent_run_id,call_id,child_run_id,arguments,background) VALUES(?,?,?,?,?)",
);
export function insert(
  db: Database.Database,
  parent: string,
  call: string,
  child: string,
  args: string,
  background: number,
) {
  return insertStatement(db).run(parent, call, child, args, background);
}

const delegatedChildStatement = statement(
  "SELECT 1 FROM delegations WHERE child_run_id=?",
);
const delegatedChildRow = z.object({ "1": z.number() });
export function delegatedChild(db: Database.Database, run: string) {
  const row = delegatedChildStatement(db).get(run);
  return row === undefined
    ? undefined
    : parseRecord(delegatedChildRow, row, "delegations");
}

const isChildStatement = statement(
  "SELECT 1 FROM delegations WHERE parent_run_id=? AND child_run_id=?",
);
const isChildRow = z.object({ "1": z.number() });
export function isChild(db: Database.Database, parent: string, child: string) {
  const row = isChildStatement(db).get(parent, child);
  return row === undefined
    ? undefined
    : parseRecord(isChildRow, row, "delegations");
}

const backgroundParentStateStatement = statement(
  "SELECT p.state FROM delegations d\n       JOIN runs child ON child.id=d.child_run_id AND child.owner_id=? AND child.agent_id=?\n       JOIN agents sender ON sender.id=child.agent_id AND sender.owner_id=child.owner_id\n       JOIN runs p ON p.id=d.parent_run_id AND p.owner_id=child.owner_id AND p.agent_id=?\n       WHERE d.child_run_id=? AND d.background=1 AND json_extract(p.payload,'$.teamId')=?",
);
const backgroundParentStateRow = z.object({ state: z.string() });
export function backgroundParentState(
  db: Database.Database,
  owner: string,
  childAgent: string,
  parentAgent: string,
  child: string | null,
  team: string | null,
) {
  const row = backgroundParentStateStatement(db).get(
    owner,
    childAgent,
    parentAgent,
    child,
    team,
  );
  return row === undefined
    ? undefined
    : parseRecord(backgroundParentStateRow, row, "delegations");
}

const mailParentConversationStatement = statement(
  "SELECT p.conversation_id FROM delegations d JOIN runs p ON p.id=d.parent_run_id WHERE d.child_run_id=? AND p.agent_id=?",
);
const mailParentConversationRow = z.object({
  conversation_id: z.string().nullable(),
});
export function mailParentConversation(
  db: Database.Database,
  child: string,
  parentAgent: string,
) {
  const row = mailParentConversationStatement(db).get(child, parentAgent);
  return row === undefined
    ? undefined
    : parseRecord(mailParentConversationRow, row, "delegations");
}

const mailChildConversationStatement = statement(
  "SELECT ch.conversation_id FROM delegations d JOIN runs p ON p.id=d.parent_run_id JOIN runs ch ON ch.id=d.child_run_id WHERE p.owner_id=? AND p.conversation_id=? AND ch.agent_id=? ORDER BY ch.created_at DESC,ch.rowid DESC LIMIT 1",
);
const mailChildConversationRow = z.object({
  conversation_id: z.string().nullable(),
});
export function mailChildConversation(
  db: Database.Database,
  owner: string,
  parentConversation: string | null,
  childAgent: string,
) {
  const row = mailChildConversationStatement(db).get(
    owner,
    parentConversation,
    childAgent,
  );
  return row === undefined
    ? undefined
    : parseRecord(mailChildConversationRow, row, "delegations");
}

const hasBlockingChildStatement = statement(
  `SELECT 1 FROM delegations d JOIN runs child ON child.id=d.child_run_id WHERE d.parent_run_id=? AND d.background=0 AND child.state IN ${ACTIVE}`,
);
const hasBlockingChildRow = z.object({ "1": z.number() });
export function hasBlockingChild(db: Database.Database, run: string) {
  const row = hasBlockingChildStatement(db).get(run);
  return row === undefined
    ? undefined
    : parseRecord(hasBlockingChildRow, row, "delegations");
}

const finishedMailResultsStatement =
  statement(`SELECT p.owner_id,d.parent_run_id,d.child_run_id,c.state FROM delegations d
       JOIN runs c ON c.id=d.child_run_id JOIN runs p ON p.id=d.parent_run_id
       JOIN teams t ON t.id=json_extract(p.payload,'$.teamId') AND t.owner_id=p.owner_id AND t.deleted_at IS NULL
       WHERE d.background=1 AND c.state IN ${FINISHED}
         AND json_extract(c.payload,'$.reviewId') IS NULL
         AND p.state<>'cancelled'
         AND NOT EXISTS(SELECT 1 FROM agent_mail m WHERE m.owner_id=p.owner_id AND m.idempotency_key='result:'||d.child_run_id||':'||c.state)
       ORDER BY c.updated_at LIMIT 200`);
const finishedMailResultsRow = z.object({
  owner_id: z.string(),
  parent_run_id: z.string(),
  child_run_id: z.string(),
  state: z.string(),
});
export function finishedMailResults(db: Database.Database) {
  return finishedMailResultsStatement(db)
    .all()
    .map((row) => parseRecord(finishedMailResultsRow, row, "delegations"));
}

const reportsStatement = statement(
  "SELECT r.agent_id,r.state,r.result,r.error FROM delegations d JOIN runs r ON r.id=d.child_run_id WHERE d.parent_run_id=? ORDER BY d.call_id",
);
const reportsRow = QueryRecords.runs.pick({
  agent_id: true,
  state: true,
  result: true,
  error: true,
});
export function reports(db: Database.Database, run: string | null) {
  return reportsStatement(db)
    .all(run)
    .map((row) => parseRecord(reportsRow, row, "delegations"));
}

const insertForegroundStatement = statement(
  "INSERT INTO delegations(parent_run_id,call_id,child_run_id,arguments,background) VALUES(?,?,?,?,0)",
);
export function insertForeground(
  db: Database.Database,
  parent: string,
  call: string,
  child: string,
  args: string,
) {
  return insertForegroundStatement(db).run(parent, call, child, args);
}

const reviewStatesStatement = statement(
  "SELECT r.agent_id,r.state,r.error FROM delegations d JOIN runs r ON r.id=d.child_run_id WHERE d.parent_run_id=? ORDER BY d.call_id",
);
const reviewStatesRow = QueryRecords.runs.pick({
  agent_id: true,
  state: true,
  error: true,
});
export function reviewStates(db: Database.Database, parent: string) {
  return reviewStatesStatement(db)
    .all(parent)
    .map((row) => parseRecord(reviewStatesRow, row, "delegations"));
}

const backgroundStatement = statement(
  "UPDATE delegations SET background=1 WHERE parent_run_id=? AND call_id=?",
);
export function background(
  db: Database.Database,
  parent: string,
  call: string,
) {
  return backgroundStatement(db).run(parent, call);
}
