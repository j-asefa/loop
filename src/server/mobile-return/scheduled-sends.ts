import * as runsQueries from "../sql/runs.js";
import {
  ScheduleInput as scheduleInput,
  ScheduleUpdateInput,
} from "../../shared/mobile-contract-schemas.js";
import { z, ZodError } from "zod";
import { db, id, now } from "../db.js";
import {
  ownedAgent,
  ownedFolder,
  ownedConversation,
  Problem,
} from "../domain.js";
import { submit } from "../agent-runtime.js";
import { attachedFiles } from "../uploads.js";
import { messageReplyContext } from "../message-replies.js";
import { attachmentDescriptors, encode, decode } from "./shared.js";
import {
  recordFleetEffect,
  recordFleetEffectEdit,
  inheritFleetEffect,
  withFleetEffect,
} from "../fleet-effect-authorizations.js";

// ---------------------------------------------------------------------------
// 6. Scheduled sends
const MONTH = 30 * 24 * 60 * 60 * 1000;
type ScheduledSend = {
  id: string;
  owner_id: string;
  agent_id: string;
  conversation_id: string | null;
  folder_id: string | null;
  /** 1 when a project (or explicitly none) was chosen; 0 uses the agent's. */
  folder_chosen: number;
  input: string;
  attachment_ids: string;
  reply_to_message_id: string | null;
  reply_excerpt: string | null;
  idempotency_key: string;
  send_at: number;
  state: string;
  run_id: string | null;
  error: string | null;
  created_at: number;
};

function validSendAt(sendAt: number, time = now()) {
  if (sendAt <= time || sendAt > time + MONTH)
    throw new Problem(400, "Choose a send time within the next 30 days");
}

export function createScheduledSend(owner: string, body: unknown) {
  const d = scheduleInput.parse(body);
  return db
    .transaction(() => {
      // A retry of accepted work returns its receipt first, before any check
      // that depends on when it is retried (the time may have passed).
      const prior = db
        .prepare(
          "SELECT * FROM scheduled_sends WHERE owner_id=? AND idempotency_key=?",
        )
        .get(owner, d.idempotencyKey) as ScheduledSend | undefined;
      if (prior) {
        const same =
          prior.agent_id === d.agentId &&
          prior.input === d.input &&
          prior.conversation_id === (d.conversationId ?? null) &&
          prior.folder_id === (d.folderId ?? null) &&
          prior.folder_chosen === Number(d.folderId !== undefined) &&
          prior.reply_to_message_id === (d.replyToMessageId ?? null) &&
          prior.reply_excerpt === (d.replyExcerpt ?? null) &&
          prior.attachment_ids === JSON.stringify(d.attachmentIds) &&
          prior.send_at === d.sendAt;
        if (!same)
          throw new Problem(409, "This request key belongs to different work");
        return { created: false, row: prior };
      }
      validSendAt(d.sendAt);
      if (runsQueries.hasIdempotency(db, owner, d.idempotencyKey))
        throw new Problem(409, "This request key belongs to different work");
      const agent = ownedAgent(d.agentId, owner);
      if (agent.retired_at)
        throw new Problem(
          409,
          "This agent is retired. Restore it from its profile before sending new work.",
        );
      if (!agent.connection_id)
        throw new Problem(409, "Connect a provider to this agent first");
      if (d.conversationId) {
        const c = ownedConversation(d.conversationId, owner);
        if (c.agent_id !== agent.id)
          throw new Problem(400, "This conversation belongs to another agent");
      }
      if (d.folderId) ownedFolder(d.folderId, owner);
      const files = attachedFiles(owner, d.attachmentIds);
      if (d.replyToMessageId)
        messageReplyContext(
          owner,
          agent.id,
          d.conversationId,
          d.replyToMessageId,
          d.replyExcerpt,
        );
      const pending = db
        .prepare(
          "SELECT count(*) n FROM scheduled_sends WHERE owner_id=? AND state='scheduled'",
        )
        .get(owner) as { n: number };
      if (pending.n >= 100)
        throw new Problem(
          429,
          "You have 100 scheduled messages. Cancel some first.",
        );
      const sendId = id();
      recordFleetEffect(owner, "scheduled", sendId);
      db.prepare(
        `INSERT INTO scheduled_sends(id,owner_id,agent_id,conversation_id,folder_id,folder_chosen,input,attachment_ids,reply_to_message_id,reply_excerpt,idempotency_key,send_at,state,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'scheduled',?)`,
      ).run(
        sendId,
        owner,
        agent.id,
        d.conversationId ?? null,
        d.folderId ?? null,
        Number(d.folderId !== undefined),
        d.input,
        JSON.stringify(files.map((file) => file.id)),
        d.replyToMessageId ?? null,
        d.replyToMessageId ? (d.replyExcerpt ?? null) : null,
        d.idempotencyKey,
        d.sendAt,
        now(),
      );
      return { created: true, row: scheduledSend(owner, sendId)! };
    })
    .immediate();
}

function scheduledSend(owner: string, sendId: string) {
  return db
    .prepare("SELECT * FROM scheduled_sends WHERE id=? AND owner_id=?")
    .get(sendId, owner) as ScheduledSend | undefined;
}

/**
 * Scheduled messages that still need you: waiting to send, or not sent
 * because Loop55 refused them when they were due. Owner-wide, or one thread's.
 */
const failedCursor = z.object({
  at: z.number(),
  created: z.number(),
  id: z.string(),
});
const FAILED_PAGE = 100;
export function listScheduledSends(
  owner: string,
  conversation?: string,
  failedBefore?: string,
) {
  if (conversation) ownedConversation(conversation, owner);
  const cursor = failedBefore
    ? decode(failedBefore, failedCursor, "scheduled")
    : null;
  // Waiting and not-sent messages are read separately, so a long history of
  // failures can never hide work that is still going to be sent. Failures
  // page newest first, so every one stays reachable to retry or dismiss.
  const select = `SELECT s.*,a.name agent_name,a.provider,c.title conversation_title,f.name folder_name
        FROM scheduled_sends s
        LEFT JOIN agents a ON a.id=s.agent_id AND a.owner_id=s.owner_id
        LEFT JOIN conversations c ON c.id=s.conversation_id AND c.owner_id=s.owner_id
        LEFT JOIN folders f ON f.id=COALESCE(s.folder_id,c.project_id) AND f.owner_id=s.owner_id
        WHERE s.owner_id=@owner AND (@conversation IS NULL OR s.conversation_id=@conversation)`;
  const failed = db
    .prepare(
      `${select} AND s.state='failed'
        AND (@at IS NULL OR s.send_at<@at OR (s.send_at=@at AND (s.created_at<@created OR (s.created_at=@created AND s.id<@id))))
        ORDER BY s.send_at DESC,s.created_at DESC,s.id DESC LIMIT @limit`,
    )
    .all({
      owner,
      conversation: conversation ?? null,
      at: cursor?.at ?? null,
      created: cursor?.created ?? null,
      id: cursor?.id ?? null,
      limit: FAILED_PAGE + 1,
    }) as ScheduledSend[];
  const more = failed.length > FAILED_PAGE;
  if (more) failed.pop();
  const last = failed.at(-1);
  // Pending messages are capped at 100 per owner, so one read holds them all.
  const pending = cursor
    ? []
    : db
        .prepare(
          `${select} AND s.state='scheduled' ORDER BY s.send_at,s.created_at`,
        )
        .all({ owner, conversation: conversation ?? null });
  // Descriptors let "Copy to a draft" bring the files back with the text.
  const withFiles = (row: ScheduledSend) => ({
    ...row,
    attachments: attachmentDescriptors(owner, JSON.parse(row.attachment_ids)),
  });
  return {
    items: [...failed, ...(pending as ScheduledSend[])].map(withFiles),
    failed_next:
      more && last
        ? encode({ at: last.send_at, created: last.created_at, id: last.id })
        : null,
  };
}

/** Cancel a waiting message, or dismiss one that could not be sent. */
export function cancelScheduledSend(owner: string, sendId: string) {
  return db
    .transaction(() => {
      const row = scheduledSend(owner, sendId);
      if (!row) throw new Problem(404, "Item not found");
      if (!["scheduled", "failed"].includes(row.state))
        throw new Problem(409, "This message was already sent or cancelled");
      db.prepare(
        "UPDATE scheduled_sends SET state='cancelled' WHERE id=? AND owner_id=? AND state IN ('scheduled','failed')",
      ).run(sendId, owner);
      return { ok: true };
    })
    .immediate();
}

/**
 * Change the text or time of a message that is still waiting to send. A
 * message that could not be sent can also be edited; that schedules it again
 * at the chosen time. It was refused, never accepted, so its stored key has
 * no run and cannot duplicate work.
 */
export function editScheduledSend(
  owner: string,
  sendId: string,
  body: unknown,
) {
  const d = ScheduleUpdateInput.parse(body ?? {});
  return db
    .transaction(() => {
      const row = scheduledSend(owner, sendId);
      if (!row) throw new Problem(404, "Item not found");
      if (!["scheduled", "failed"].includes(row.state))
        throw new Problem(409, "This message was already sent or cancelled");
      if (row.state === "failed") {
        if (d.sendAt === undefined)
          throw new Problem(400, "Choose a new time to send it");
        if (row.run_id) throw new Problem(409, "This message was already sent");
        const pending = db
          .prepare(
            "SELECT count(*) n FROM scheduled_sends WHERE owner_id=? AND state='scheduled'",
          )
          .get(owner) as { n: number };
        if (pending.n >= 100)
          throw new Problem(
            429,
            "You have 100 scheduled messages. Cancel some first.",
          );
      }
      if (d.sendAt !== undefined) validSendAt(d.sendAt);
      recordFleetEffectEdit(owner, "scheduled", row.id);
      db.prepare(
        "UPDATE scheduled_sends SET input=?,send_at=?,state='scheduled',error=NULL WHERE id=? AND owner_id=? AND state IN ('scheduled','failed')",
      ).run(d.input ?? row.input, d.sendAt ?? row.send_at, sendId, owner);
      return scheduledSend(owner, sendId)!;
    })
    .immediate();
}

// Submits a scheduled message with its stored idempotency key, inside the
// caller's transaction: if it was already accepted, submit() returns that run.
function submitScheduled(row: ScheduledSend) {
  const run = withFleetEffect(row.owner_id, "scheduled", row.id, () =>
    submit(row.owner_id, {
      agentId: row.agent_id,
      conversationId: row.conversation_id ?? undefined,
      // "No project" stays null; only an unchosen project uses the agent's.
      folderId: row.folder_chosen ? row.folder_id : undefined,
      input: row.input,
      attachmentIds: JSON.parse(row.attachment_ids),
      replyToMessageId: row.reply_to_message_id ?? undefined,
      replyExcerpt: row.reply_excerpt ?? undefined,
      idempotencyKey: row.idempotency_key,
      // A deferred message never steers work that started after it was
      // written; it queues behind the conversation's current run.
      steer: false,
      personal: true,
    }),
  );
  inheritFleetEffect(row.owner_id, "scheduled", row.id, run.id);
  db.prepare(
    "UPDATE scheduled_sends SET state='submitted',run_id=?,error=NULL WHERE id=?",
  ).run(run.id, row.id);
  return run;
}
const refusal = (error: unknown) =>
  error instanceof Problem
    ? error.message
    : error instanceof ZodError
      ? "This scheduled message is no longer valid."
      : null;

/**
 * Send a message that could not be sent, now, after you ask to. It was
 * refused, never accepted, so its stored key cannot duplicate work; if it is
 * refused again the reason is kept and returned.
 */
export function retryScheduledSend(owner: string, sendId: string) {
  return db
    .transaction(() => {
      const row = scheduledSend(owner, sendId);
      if (!row) throw new Problem(404, "Item not found");
      if (row.state !== "failed")
        throw new Problem(
          409,
          "Only a message that could not be sent can be retried",
        );
      recordFleetEffectEdit(owner, "scheduled", row.id);
      try {
        return {
          run: submitScheduled(row),
          row: scheduledSend(owner, sendId)!,
        };
      } catch (error) {
        const reason = refusal(error);
        if (reason === null) throw error;
        db.prepare("UPDATE scheduled_sends SET error=? WHERE id=?").run(
          reason,
          row.id,
        );
        return { run: null, row: scheduledSend(owner, sendId)! };
      }
    })
    .immediate();
}

// Worker job. The row's claim and the run it creates commit in one immediate
// transaction, and submit() reuses the stored idempotency key: a crash or a
// second worker can only find the existing run, never create another. Only a
// definite refusal marks a message failed; any other error rolls back and the
// message is tried again on the next pass.
export function deliverScheduledSends(time = now()) {
  const due = db
    .prepare(
      "SELECT id FROM scheduled_sends WHERE state='scheduled' AND send_at<=? ORDER BY send_at,rowid LIMIT 20",
    )
    .all(time) as { id: string }[];
  let submitted = 0;
  for (const { id: sendId } of due)
    db.transaction(() => {
      const row = db
        .prepare(
          "SELECT * FROM scheduled_sends WHERE id=? AND state='scheduled'",
        )
        .get(sendId) as ScheduledSend | undefined;
      if (!row) return;
      try {
        submitScheduled(row);
        submitted++;
      } catch (error) {
        const reason = refusal(error);
        if (reason === null) throw error;
        db.prepare(
          "UPDATE scheduled_sends SET state='failed',error=? WHERE id=?",
        ).run(reason, row.id);
      }
    }).immediate();
  return submitted;
}
