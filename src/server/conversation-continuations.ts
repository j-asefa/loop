import {
  MessageMetadata,
  writeMessageMetadata,
} from "../shared/message-metadata.js";
import * as continuationRequestsQueries from "./sql/continuation-requests.js";
import * as conversationsQueries from "./sql/conversations.js";
import * as messagesQueries from "./sql/messages.js";
import type { z } from "zod";
import type { ContinueInput } from "../shared/library-contract-schemas.js";
import { db, id, now } from "./db.js";
import {
  ownedAgent,
  ownedConnection,
  ownedConversation,
  ownedMessage,
  Problem,
} from "./domain.js";
import { submit } from "./agent-runtime.js";

type ContinuationInput = z.infer<typeof ContinueInput>;
export function continueConversation(
  owner: string,
  sourceId: string,
  data: ContinuationInput,
) {
  return db
    .transaction(() => {
      const messageIds = [...new Set(data.messageIds)].sort();
      const request = JSON.stringify({
        sourceId,
        agentId: data.agentId,
        messageIds,
        input: data.start.input,
      });
      // The conversation, first send and immutable request commit together.
      // Queued prompts can be edited, so they cannot serve as request receipts.
      const previous = continuationRequestsQueries.receipt(
        db,
        owner,
        data.start.idempotencyKey,
      );
      if (previous) {
        if (previous.request !== request)
          throw new Problem(
            409,
            "This request key belongs to a different continuation",
          );
        const available = conversationsQueries.ownedRunExists(
          db,
          owner,
          previous.conversation_id,
          previous.run_id,
        );
        // Reading an accepted receipt does not reconnect, resubmit or replay work.
        // Its identity survives deletion of either thread or the original run.
        return {
          id: previous.conversation_id,
          agentId: data.agentId,
          runId: previous.run_id,
          ...(!available ? { unavailable: true as const } : {}),
        };
      }
      const source = ownedConversation(sourceId, owner);
      const agent = ownedAgent(data.agentId, owner);
      if (!agent.connection_id)
        throw new Problem(409, "Choose an agent with a connected model");
      ownedConnection(agent.connection_id, owner);
      const messages = messageIds.map((mid) => ownedMessage(mid, owner));
      if (messages.some((m) => m.conversation_id !== source.id))
        throw new Problem(400, "Choose messages from this conversation only");
      // Resolve equal timestamps in source order, independent of checkbox order.
      const order = new Map(
        messagesQueries
          .continuationPositions(
            db,
            owner,
            source.id,
            JSON.stringify(messageIds),
          )
          .map((m) => [m.id, m.seq]),
      );
      messages.sort(
        (a, b) =>
          a.created_at - b.created_at || order.get(a.id)! - order.get(b.id)!,
      );
      const conversationId = id();
      conversationsQueries.insertExternal(
        db,
        conversationId,
        owner,
        agent.id,
        ("Continuation: " + source.title).slice(0, 200),
        "loop-continuation",
        null,
        now(),
      );

      for (const message of messages)
        messagesQueries.insert(
          db,
          id(),
          owner,
          conversationId,
          null,
          message.role,
          message.content,
          writeMessageMetadata({
            sourceConversation: source.id,
            sourceMessage: message.id,
            selectedByUser: true,
            attachments: message.metadata.attachments || [],
            original: MessageMetadata.shape.original.parse(message.metadata),
          }),
          message.created_at,
        );
      const run = submit(owner, {
        agentId: agent.id,
        conversationId,
        input: data.start.input,
        idempotencyKey: data.start.idempotencyKey,
        personal: true,
      });
      continuationRequestsQueries.insert(
        db,
        owner,
        data.start.idempotencyKey,
        request,
        conversationId,
        run.id,
        now(),
      );
      return {
        id: conversationId,
        agentId: agent.id,
        runId: run.id,
      };
    })
    .immediate();
}
