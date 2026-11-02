import {
  PERSONAL_DECISION_DETAIL_LIMIT,
  PERSONAL_DECISION_RESPONSE_LIMIT,
} from "../../shared/personal-decisions.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const approvalStatement = statement(
  "SELECT\n      CASE WHEN a.id IS NOT NULL THEN 'approval' ELSE 'native' END source,\n      COALESCE(a.request,d.request) request\n    FROM personal_decisions h\n    JOIN runs r ON r.id=h.run_id AND r.owner_id=h.owner_id\n    LEFT JOIN conversations c ON c.id=r.conversation_id AND c.owner_id=h.owner_id\n    LEFT JOIN approvals a ON a.id=h.approval_id AND a.owner_id=h.owner_id AND a.run_id=r.id\n    LEFT JOIN native_decisions d ON d.id=h.native_decision_id AND d.run_id=r.id AND d.conversation_id=r.conversation_id\n    WHERE h.id=? AND h.owner_id=? AND h.kind='approval'\n      AND (a.id IS NOT NULL OR d.id IS NOT NULL)\n      AND (r.conversation_id IS NULL OR c.id IS NOT NULL)",
);
const approvalRow = z.object({
  source: z.enum(["approval", "native"]),
  request: z.string(),
});
export function approval(db: Database.Database, id: string, owner: string) {
  const row = approvalStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(approvalRow, row, "personal_decisions");
}

const insertStatement = statement(
  "INSERT INTO personal_decisions\n    (id,owner_id,run_id,approval_id,native_decision_id,kind,response,response_truncated,created_at)\n    VALUES(?,?,?,?,?,?,?,?,?)",
);
export function insert(
  db: Database.Database,
  id: string,
  owner: string,
  run: string,
  approval: string | null,
  native: string | null,
  kind: string,
  response: string,
  truncated: number,
  created: number,
) {
  return insertStatement(db).run(
    id,
    owner,
    run,
    approval,
    native,
    kind,
    response,
    truncated,
    created,
  );
}

const pageStatement =
  statement(`SELECT h.id,h.kind,substr(h.response,1,${PERSONAL_DECISION_RESPONSE_LIMIT + 1}) response,
      h.response_truncated,h.created_at,h.native_decision_id,
      CASE WHEN h.approval_id IS NOT NULL THEN json_object(
        'tool',substr(json_extract(a.request,'$.tool'),1,1025),
        'type',substr(json_extract(a.request,'$.type'),1,256),
        'message',substr(json_extract(a.request,'$.message'),1,${PERSONAL_DECISION_DETAIL_LIMIT + 1}),
        'content',substr(json_extract(a.request,'$.content'),1,${PERSONAL_DECISION_DETAIL_LIMIT + 1}),
        'argumentsText',substr(json_extract(a.request,'$.arguments'),1,${PERSONAL_DECISION_DETAIL_LIMIT + 1})
      ) ELSE json_object(
        'title',substr(json_extract(d.request,'$.title'),1,1025),
        'detail',substr(json_extract(d.request,'$.detail'),1,${PERSONAL_DECISION_DETAIL_LIMIT + 1}),
        'questionsText',substr(json_extract(d.request,'$.questions'),1,65537)
      ) END request,
      CASE WHEN h.approval_id IS NOT NULL THEN 'resolved' ELSE d.state END state,
      c.id conversation_id,substr(c.title,1,1025) conversation_title,substr(g.name,1,257) agent_name
    FROM personal_decisions h
    JOIN runs r ON r.id=h.run_id AND r.owner_id=h.owner_id
    LEFT JOIN approvals a ON a.id=h.approval_id AND a.owner_id=h.owner_id AND a.run_id=r.id
    LEFT JOIN native_decisions d ON d.id=h.native_decision_id AND d.run_id=r.id AND d.conversation_id=r.conversation_id
    LEFT JOIN conversations c ON c.id=r.conversation_id AND c.owner_id=h.owner_id
    LEFT JOIN agents g ON g.id=r.agent_id AND g.owner_id=h.owner_id
    WHERE h.owner_id=? AND h.kind=? AND (a.id IS NOT NULL OR d.id IS NOT NULL)
      AND (r.conversation_id IS NULL OR c.id IS NOT NULL)
      AND (h.created_at,h.id)<(?,?)
    ORDER BY h.created_at DESC,h.id DESC LIMIT 51`);
const pageRow = QueryRecords.personal_decisions
  .pick({
    id: true,
    kind: true,
    response: true,
    response_truncated: true,
    native_decision_id: true,
    created_at: true,
  })
  .extend({
    request: z.string(),
    state: z.string(),
    conversation_id: z.string().nullable(),
    conversation_title: z.string().nullable(),
    agent_name: z.string().nullable(),
  });
export function page(
  db: Database.Database,
  owner: string,
  kind: string,
  at: number,
  id: string,
) {
  return pageStatement(db)
    .all(owner, kind, at, id)
    .map((row) => parseRecord(pageRow, row, "personal_decisions"));
}

const removeNativeDecisionStatement = statement(
  "DELETE FROM personal_decisions WHERE native_decision_id=?",
);
export function removeNativeDecision(db: Database.Database, id: string) {
  return removeNativeDecisionStatement(db).run(id);
}
