import * as messagesQueries from "../sql/messages.js";
import { PositionInput } from "../../shared/mobile-contract-schemas.js";
import { db, now } from "../db.js";
import { ownedConversation, Problem } from "../domain.js";

// ---------------------------------------------------------------------------
// 1. Reading position
// Where you stopped reading a thread, so reopening it continues from there.
function readingPosition(owner: string, conversation: string) {
  return (
    (
      db
        .prepare(
          "SELECT position_message_id FROM conversation_positions WHERE owner_id=? AND conversation_id=?",
        )
        .get(owner, conversation) as
        { position_message_id: string | null } | undefined
    )?.position_message_id ?? null
  );
}

export function conversationReturnState(owner: string, conversation: string) {
  // A reply is saved when it was saved itself or its result card is saved.
  const saved = (
    db
      .prepare(
        `SELECT b.message_id FROM message_bookmarks b JOIN messages m ON m.id=b.message_id AND m.owner_id=b.owner_id WHERE b.owner_id=@owner AND m.conversation_id=@conversation
        UNION SELECT json_extract(a.metadata,'$.messageId') FROM artifacts a WHERE a.owner_id=@owner AND a.conversation_id=@conversation AND a.pinned=1 AND a.archived=0 AND json_extract(a.metadata,'$.messageId') IS NOT NULL`,
      )
      .all({ owner, conversation }) as { message_id: string }[]
  ).map((row) => row.message_id);
  return {
    position_message_id: readingPosition(owner, conversation),
    saved,
  };
}

function conversationMessage(
  owner: string,
  conversation: string,
  message: string,
) {
  return messagesQueries.conversationPosition(
    db,
    message,
    owner,
    conversation,
  ) as { id: string; created_at: number } | undefined;
}

export function savePosition(
  owner: string,
  conversation: string,
  body: unknown,
) {
  const { positionMessageId } = PositionInput.parse(body ?? {});
  return db
    .transaction(() => {
      const c = ownedConversation(conversation, owner);
      if (positionMessageId) {
        const valid = conversationMessage(owner, c.id, positionMessageId);
        if (!valid)
          throw new Problem(404, "Message not found in this conversation");
      }
      db.prepare(
        `INSERT INTO conversation_positions(owner_id,conversation_id,position_message_id,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(owner_id,conversation_id) DO UPDATE SET position_message_id=excluded.position_message_id,updated_at=excluded.updated_at`,
      ).run(owner, c.id, positionMessageId, now());
      return { position_message_id: positionMessageId };
    })
    .immediate();
}
