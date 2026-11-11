import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const existsOwnedStatement = statement(
  "SELECT 1 FROM native_decisions d JOIN runs r ON r.id=d.run_id WHERE d.id=? AND r.owner_id=?",
);
const existsOwnedRow = z.object({ "1": z.number() });
export function existsOwned(db: Database.Database, id: string, owner: string) {
  const row = existsOwnedStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(existsOwnedRow, row, "native_decisions");
}

const insertPendingStatement = statement(
  "INSERT INTO native_decisions(id,run_id,conversation_id,generation,native_id,request,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(conversation_id,generation,native_id) DO NOTHING",
);
export function insertPending(
  db: Database.Database,
  id: string,
  run: string,
  conversation: string,
  generation: string,
  native: string,
  request: string,
  created: number,
) {
  return insertPendingStatement(db).run(
    id,
    run,
    conversation,
    generation,
    native,
    request,
    created,
  );
}

const byRequestStatement = statement(
  "SELECT state FROM native_decisions WHERE conversation_id=? AND generation=? AND native_id=?",
);
const byRequestRow = QueryRecords.native_decisions.pick({ state: true });
export function byRequest(
  db: Database.Database,
  conversation: string,
  generation: string,
  native: string,
) {
  const row = byRequestStatement(db).get(conversation, generation, native);
  return row === undefined
    ? undefined
    : parseRecord(byRequestRow, row, "native_decisions").state;
}

const getStatement = statement("SELECT * FROM native_decisions WHERE id=?");

export function get(db: Database.Database, id: string) {
  const row = getStatement(db).get(id);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.native_decisions, row, "native_decisions");
}

const beginAnswerStatement = statement(
  "UPDATE native_decisions SET state='deciding',command_id=?,digest=? WHERE id=? AND state='pending'",
);
export function beginAnswer(
  db: Database.Database,
  command: string,
  digest: string,
  id: string,
) {
  return beginAnswerStatement(db).run(command, digest, id);
}

const decisionReceiptStatement = statement(
  "SELECT state,command_id,digest FROM native_decisions WHERE id=?",
);
const decisionReceiptRow = QueryRecords.native_decisions.pick({
  state: true,
  command_id: true,
  digest: true,
});
export function decisionReceipt(db: Database.Database, id: string) {
  const row = decisionReceiptStatement(db).get(id);
  return row === undefined
    ? undefined
    : parseRecord(decisionReceiptRow, row, "native_decisions");
}

const reopenStatement = statement(
  "UPDATE native_decisions SET state='pending',command_id=NULL,digest=NULL WHERE id=? AND state='deciding'",
);
export function reopen(db: Database.Database, id: string) {
  return reopenStatement(db).run(id);
}

const stateStatement = statement(
  "SELECT state FROM native_decisions WHERE id=?",
);
const stateRow = QueryRecords.native_decisions.pick({ state: true });
export function state(db: Database.Database, id: string) {
  const row = stateStatement(db).get(id);
  return row === undefined
    ? undefined
    : parseRecord(stateRow, row, "native_decisions");
}

const finishByIdStatement = statement(
  "UPDATE native_decisions SET state=? WHERE (id=?) AND state<>?\n",
);
export function finishById(
  db: Database.Database,
  state: "resolved" | "expired" | "unknown",
  id: string,
) {
  return db
    .transaction(() => finishByIdStatement(db).run(state, id, state))
    .immediate();
}

const finishDecidingByIdStatement = statement(
  "UPDATE native_decisions SET state=? WHERE (id=? AND state='deciding') AND state<>?\n",
);
export function finishDecidingById(
  db: Database.Database,
  state: "resolved" | "expired" | "unknown",
  id: string,
) {
  return db
    .transaction(() => finishDecidingByIdStatement(db).run(state, id, state))
    .immediate();
}

const finishRequestStatement = statement(
  "UPDATE native_decisions SET state=? WHERE (conversation_id=? AND generation=? AND native_id=? AND state IN ('pending','deciding')) AND state<>?\n",
);
export function finishRequest(
  db: Database.Database,
  state: "resolved" | "expired" | "unknown",
  conversation: string,
  generation: string,
  native: string,
) {
  return db
    .transaction(() =>
      finishRequestStatement(db).run(
        state,
        conversation,
        generation,
        native,
        state,
      ),
    )
    .immediate();
}

const finishPendingRunStatement = statement(
  "UPDATE native_decisions SET state=? WHERE (run_id=? AND state='pending') AND state<>?\n",
);
export function finishPendingRun(
  db: Database.Database,
  state: "resolved" | "expired" | "unknown",
  run: string,
) {
  return db
    .transaction(() => finishPendingRunStatement(db).run(state, run, state))
    .immediate();
}

const finishPendingGenerationStatement = statement(
  "UPDATE native_decisions SET state=? WHERE (conversation_id=? AND generation=? AND state='pending') AND state<>?\n",
);
export function finishPendingGeneration(
  db: Database.Database,
  state: "resolved" | "expired" | "unknown",
  conversation: string,
  generation: string,
) {
  return db
    .transaction(() =>
      finishPendingGenerationStatement(db).run(
        state,
        conversation,
        generation,
        state,
      ),
    )
    .immediate();
}

const finishPendingStatement = statement(
  "UPDATE native_decisions SET state=? WHERE (state='pending') AND state<>?\n",
);
export function finishPending(
  db: Database.Database,
  state: "resolved" | "expired" | "unknown",
) {
  return db
    .transaction(() => finishPendingStatement(db).run(state, state))
    .immediate();
}

const finishDecidingStatement = statement(
  "UPDATE native_decisions SET state=? WHERE (state='deciding') AND state<>?\n",
);
export function finishDeciding(
  db: Database.Database,
  state: "resolved" | "expired" | "unknown",
) {
  return db
    .transaction(() => finishDecidingStatement(db).run(state, state))
    .immediate();
}

const pendingWebhookStatement = statement(
  "SELECT id,json_extract(request,'$.kind') kind FROM native_decisions WHERE run_id=? AND state='pending' ORDER BY created_at,id LIMIT 1",
);
const pendingWebhookRow = QueryRecords.native_decisions
  .pick({ id: true })
  .extend({ kind: z.string().nullable() });
export function pendingWebhook(db: Database.Database, run: string) {
  const row = pendingWebhookStatement(db).get(run);
  return row === undefined
    ? undefined
    : parseRecord(pendingWebhookRow, row, "native_decisions");
}

const ownedGenerationStatement = statement(
  "SELECT d.generation FROM native_decisions d JOIN runs r ON r.id=d.run_id JOIN conversations c ON c.id=d.conversation_id WHERE d.id=@id AND r.owner_id=@owner AND c.owner_id=@owner",
);

const ownedGenerationRow = QueryRecords.native_decisions.pick({
  generation: true,
});

export function ownedGeneration(
  db: Database.Database,
  id: string,
  owner: string,
) {
  const row = ownedGenerationStatement(db).get({ id, owner });
  return row === undefined
    ? undefined
    : parseRecord(ownedGenerationRow, row, "native_decisions");
}

const ownedGenerationStateStatement = statement(
  "SELECT d.state FROM native_decisions d JOIN runs r ON r.id=d.run_id JOIN conversations c ON c.id=d.conversation_id WHERE d.id=@id AND d.generation=@generation AND r.owner_id=@owner AND c.owner_id=@owner",
);

const ownedGenerationStateRow = QueryRecords.native_decisions.pick({
  state: true,
});

export function ownedGenerationState(
  db: Database.Database,
  id: string,
  generation: string,
  owner: string,
) {
  const row = ownedGenerationStateStatement(db).get({ id, generation, owner });
  return row === undefined
    ? undefined
    : parseRecord(ownedGenerationStateRow, row, "native_decisions");
}

const conversationStatement = statement(
  "SELECT conversation_id FROM native_decisions WHERE id=?",
);

const conversationRow = QueryRecords.native_decisions.pick({
  conversation_id: true,
});

export function conversation(db: Database.Database, id: string) {
  const row = conversationStatement(db).get(id);
  return row === undefined
    ? undefined
    : parseRecord(conversationRow, row, "native_decisions");
}

const visibleForOwnerStatement = statement(
  "SELECT d.*,a.name,a.provider,r.input FROM native_decisions d JOIN runs r ON r.id=d.run_id LEFT JOIN agents a ON a.id=r.agent_id WHERE d.state IN ('pending','deciding','unknown') AND r.owner_id=@owner AND (@conversation IS NULL OR d.conversation_id=@conversation) ORDER BY d.created_at",
);

const visibleForOwnerRow = QueryRecords.native_decisions.extend({
  name: z.string().nullable(),
  provider: z.string().nullable(),
  input: z.string(),
});

export function visibleForOwner(
  db: Database.Database,
  owner: string,
  conversation: string | null,
) {
  return visibleForOwnerStatement(db)
    .all({ owner, conversation })
    .map((row) => parseRecord(visibleForOwnerRow, row, "native_decisions"));
}
