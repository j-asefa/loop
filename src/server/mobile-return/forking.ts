import {
  MessageMetadata,
  writeMessageMetadata,
} from "../../shared/message-metadata.js";
import * as conversationsQueries from "../sql/conversations.js";
import * as messagesQueries from "../sql/messages.js";
import { ConversationForkInput } from "../../shared/mobile-contract-schemas.js";
import { parseMessages } from "../row-schemas.js";
import { db, id, now } from "../db.js";
import {
  ownedAgent,
  ownedConversation,
  ownedConnection,
  Problem,
} from "../domain.js";

// ---------------------------------------------------------------------------
// 9. Fork
export function forkConversation(
  owner: string,
  conversation: string,
  body: unknown,
) {
  const d = ConversationForkInput.parse(body);
  return db
    .transaction(() => {
      const c = ownedConversation(conversation, owner);
      const agentId = d.agentId || c.agent_id;
      if (!agentId) throw new Problem(400, "Choose an agent for the fork");
      const agent = ownedAgent(agentId, owner);
      if (!agent.connection_id)
        throw new Problem(409, "Choose an agent with a connected model");
      const target = messagesQueries.forkPosition(db, d.messageId, owner, c.id);
      if (!target)
        throw new Problem(404, "Message not found in this conversation");
      const messages = parseMessages(
        messagesQueries.forkHistory(
          db,
          owner,
          c.id,
          target.created_at,
          target.seq,
        ),
      );
      const forkId = id();
      // Bind the fork to the selected agent's connection now, as a first send
      // to a new conversation would.
      const connection = ownedConnection(agent.connection_id, owner);
      conversationsQueries.insertFork(
        db,
        forkId,
        owner,
        agent.id,
        ("Fork: " + c.title).slice(0, 200),
        "loop-fork",
        null,
        now(),
        c.project_id,
        connection.id,
      );

      for (const m of messages) {
        const metadata = m.metadata;
        messagesQueries.insert(
          db,
          id(),
          owner,
          forkId,
          null,
          m.role,
          m.content,
          writeMessageMetadata({
            sourceConversation: c.id,
            sourceMessage: m.id,
            forked: true,
            // Native backends start fresh sessions from these copied turns.
            selectedByUser: true,
            attachments: metadata.attachments || [],
            original: MessageMetadata.shape.original.parse(metadata),
          }),
          m.created_at,
        );
      }
      return { id: forkId, agentId: agent.id };
    })
    .immediate();
}
