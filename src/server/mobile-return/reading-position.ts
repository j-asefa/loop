import * as conversationPositionsQueries from "../sql/conversation-positions.js";
import * as messageBookmarksQueries from "../sql/message-bookmarks.js";
import * as messagesQueries from "../sql/messages.js";
import { PositionInput } from "../../shared/mobile-contract-schemas.js";
import { db, now } from "../db.js";
import { ownedConversation, Problem } from "../domain.js";

// ---------------------------------------------------------------------------
// 1. Reading position
// Where you stopped reading a thread, so reopening it continues from there.
function readingPosition(owner: string, conversation: string) {
  return (
    conversationPositionsQueries.position(db, owner, conversation)
      ?.position_message_id ?? null
  );
}

export function conversationReturnState(owner: string, conversation: string) {
  // A reply is saved when it was saved itself or its result card is saved.
  const saved = messageBookmarksQueries
    .conversationSaved(db, { owner, conversation })
    .map((row) => row.message_id);
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
  return messagesQueries.conversationPosition(db, message, owner, conversation);
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
      conversationPositionsQueries.save(
        db,
        owner,
        c.id,
        positionMessageId,
        now(),
      );
      return { position_message_id: positionMessageId };
    })
    .immediate();
}
