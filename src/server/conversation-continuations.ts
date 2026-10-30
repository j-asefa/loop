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
import { MessageMetadata } from "./row-schemas.js";
import { submit } from "./agent-runtime.js";

type ContinuationInput = z.infer<typeof ContinueInput>;
type ContinuationResult = {
  id: string;
  agentId: string;
  runId?: string;
  unavailable?: true;
};
export function continueConversation(
  owner: string,
  sourceId: string,
  data: ContinuationInput & { start: NonNullable<ContinuationInput["start"]> },
): ContinuationResult & { runId: string };
export function continueConversation(
  owner: string,
  sourceId: string,
  data: ContinuationInput,
): ContinuationResult;
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
        input: data.start?.input,
      });
      // The conversation, first send and immutable request commit together.
      // Queued prompts can be edited, so they cannot serve as request receipts.
      const previous =
        data.start &&
        (db
          .prepare(
            "SELECT request,conversation_id,run_id FROM continuation_requests WHERE owner_id=? AND idempotency_key=?",
          )
          .get(owner, data.start.idempotencyKey) as
          | { request: string; conversation_id: string; run_id: string }
          | undefined);
      if (previous && data.start) {
        if (previous.request !== request)
          throw new Problem(
            409,
            "This request key belongs to a different continuation",
          );
        const available = db
          .prepare(
            "SELECT 1 FROM conversations c JOIN runs r ON r.conversation_id=c.id AND r.owner_id=c.owner_id WHERE c.owner_id=? AND c.id=? AND r.id=?",
          )
          .get(owner, previous.conversation_id, previous.run_id);
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
        (
          db
            .prepare(
              "SELECT id,rowid seq FROM messages WHERE owner_id=? AND conversation_id=? AND id IN (SELECT value FROM json_each(?))",
            )
            .all(owner, source.id, JSON.stringify(messageIds)) as {
            id: string;
            seq: number;
          }[]
        ).map((m) => [m.id, m.seq]),
      );
      messages.sort(
        (a, b) =>
          a.created_at - b.created_at || order.get(a.id)! - order.get(b.id)!,
      );
      const conversationId = id();
      db.prepare(
        "INSERT INTO conversations(id,owner_id,agent_id,title,origin,external_id,created_at) VALUES(?,?,?,?,?,?,?)",
      ).run(
        conversationId,
        owner,
        agent.id,
        ("Continuation: " + source.title).slice(0, 200),
        "loop55-continuation",
        null,
        now(),
      );
      const insert = db.prepare(
        "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,?,?,?,?)",
      );
      for (const message of messages)
        insert.run(
          id(),
          owner,
          conversationId,
          null,
          message.role,
          message.content,
          JSON.stringify(
            MessageMetadata.parse({
              sourceConversation: source.id,
              sourceMessage: message.id,
              selectedByUser: true,
              attachments: message.metadata.attachments || [],
              original: message.metadata,
            }),
          ),
          message.created_at,
        );
      const run = data.start
        ? submit(owner, {
            agentId: agent.id,
            conversationId,
            input: data.start.input,
            idempotencyKey: data.start.idempotencyKey,
            personal: true,
          })
        : undefined;
      if (run && data.start)
        db.prepare(
          "INSERT INTO continuation_requests(owner_id,idempotency_key,request,conversation_id,run_id,created_at) VALUES(?,?,?,?,?,?)",
        ).run(
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
        ...(run ? { runId: run.id } : {}),
      };
    })
    .immediate();
}
