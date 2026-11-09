import { canSwapQueuedRuns, editableQueuedRun } from "../queued-run-policy.js";
import * as delegationsQueries from "../sql/delegations.js";
import * as messagesQueries from "../sql/messages.js";
import * as runsQueries from "../sql/runs.js";
import {
  RunReorderInput,
  QueuedRunInput,
  RunWithdrawInput,
  RunMoveInput,
} from "../../shared/mobile-contract-schemas.js";
import { db, emit, now } from "../db.js";
import { ownedRun, Problem } from "../domain.js";
import { submit } from "../agent-runtime.js";
import { transition } from "../queue.js";

import { MAX_MESSAGE_FILES } from "../../shared/uploads.js";
import { attachmentDescriptors } from "./shared.js";
import {
  recordEffectEdit,
  assertEffect,
  inheritEffect,
} from "../effect-authority.js";

const RANK_STEP = 1 / 1024;

export function reorderRun(owner: string, runId: string, body: unknown) {
  const { direction } = RunReorderInput.parse(body);
  return db
    .transaction(() => {
      const run = ownedRun(runId, owner);
      if (run.state !== "queued" || !run.agent_id)
        throw new Problem(409, "Only queued work can be reordered");
      const peers = runsQueries.queuePeers(db, run.id, owner);
      const index = peers.findIndex((peer) => peer.id === run.id);
      const other = index + (direction === "up" ? -1 : 1);
      if (index < 0 || other < 0 || other >= peers.length)
        throw new Problem(409, "There is no queued message to swap with");
      if (!canSwapQueuedRuns(peers, index, other))
        throw new Problem(
          409,
          "Messages in the same thread run in the order they were sent",
        );
      const keys = peers.map((peer) => peer.queue_key);
      const reordered = [...peers];
      [reordered[index], reordered[other]] = [
        reordered[other],
        reordered[index],
      ];
      // Keep ranks near their original times and strictly increasing, so
      // equal timestamps cannot fall back to insertion order.
      let previous = -Infinity;
      reordered.forEach((peer, position) => {
        const rank = Math.max(keys[position], previous + RANK_STEP);
        previous = rank;
        if (rank !== peer.queue_key)
          runsQueries.rankQueued(db, rank, peer.id, owner);
      });
      emit(owner, run.id, "queue.reordered", { direction });
      return { ok: true };
    })
    .immediate();
}

export function editQueuedRun(owner: string, runId: string, body: unknown) {
  const { input } = QueuedRunInput.parse(body);
  return db
    .transaction(() => {
      const run = ownedRun(runId, owner);
      if (!editableQueuedRun(db, run))
        throw new Problem(
          409,
          "This message has already started. It can no longer be edited.",
        );
      recordEffectEdit(owner, "run", run.id);
      runsQueries.editQueuedInput(db, input, now(), run.id, owner);
      messagesQueries.editRunUserContent(db, input, run.id, owner);
      emit(owner, run.id, "queue.edited", {});
      return { ok: true };
    })
    .immediate();
}

/**
 * Take a queued message back into a draft: cancels it only if it has never
 * started, and returns its text so nothing is lost. A message the agent has
 * already started is never cancelled from here.
 */
export function withdrawQueuedRun(
  owner: string,
  runId: string,
  body: unknown = {},
) {
  // The files already in the draft it goes back to: the run is only
  // cancelled if its own files fit beside them.
  const { draftAttachmentIds } = RunWithdrawInput.parse(body ?? {});
  return db
    .transaction(() => {
      const run = ownedRun(runId, owner);
      if (
        run.kind !== "agent" ||
        !editableQueuedRun(db, run) ||
        delegationsQueries.delegatedChild(db, run.id)
      )
        throw new Problem(
          409,
          "This message has already started, so it can no longer be moved back to a draft.",
        );
      // The draft gets the message's files back too; if one is gone, the
      // message stays queued rather than come back without it.
      const ids = (run.payload.attachmentIds || []) as string[];
      const attachments = attachmentDescriptors(owner, ids);
      if (attachments.length !== ids.length)
        throw new Problem(
          409,
          "A file attached to this message is no longer available, so it was left queued.",
        );
      if (new Set([...draftAttachmentIds, ...ids]).size > MAX_MESSAGE_FILES)
        throw new Problem(
          409,
          `Your draft's files and this message's would be more than ${MAX_MESSAGE_FILES}, so it was left queued. Send or remove some files from the draft first.`,
        );
      if (!transition(run, "cancelled", { reason: "Moved back to a draft" }))
        throw new Problem(409, "This message has already started");
      return {
        input: run.input,
        agent_id: run.agent_id,
        conversation_id: run.conversation_id,
        attachment_ids: ids,
        attachments,
      };
    })
    .immediate();
}

export function moveQueuedRun(owner: string, runId: string, body: unknown) {
  const d = RunMoveInput.parse(body);
  return db
    .transaction(() => {
      const run = ownedRun(runId, owner);
      const payload = run.payload;
      const request = {
        agentId: d.agentId,
        input: run.input,
        idempotencyKey: d.idempotencyKey,
        attachmentIds: payload.attachmentIds || [],
        folderId:
          typeof payload.folderId === "string" ? payload.folderId : undefined,
        steer: false,
        personal: true,
      };
      // A repeated move returns the run the first attempt created.
      if (runsQueries.hasIdempotency(db, owner, d.idempotencyKey))
        return submit(owner, request);
      if (
        run.kind !== "agent" ||
        !editableQueuedRun(db, run) ||
        delegationsQueries.delegatedChild(db, run.id)
      )
        throw new Problem(409, "Only a queued message you sent can be moved");
      assertEffect(owner, "run", run.id);
      if (!transition(run, "cancelled", { reason: "Moved to another agent" }))
        throw new Problem(409, "This message has already started");
      // submit() throwing rolls back the cancellation too.
      const moved = submit(owner, request);
      inheritEffect(owner, "run", run.id, moved.id);
      return moved;
    })
    .immediate();
}
