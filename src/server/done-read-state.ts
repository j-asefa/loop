import { db } from "./db.js";

export function doneUnreadVersion(
  owner: string,
  conversation: string,
  key: string,
) {
  return (
    (
      db
        .prepare(
          "SELECT version FROM done_card_unread_versions WHERE owner_id=? AND conversation_id=? AND card_key=?",
        )
        .get(owner, conversation, key) as { version: number } | undefined
    )?.version ?? 0
  );
}

/** The owning card/group mutation validates access and holds the transaction. */
export function advanceDoneUnreadVersion(
  owner: string,
  conversation: string,
  key: string,
) {
  return (
    db
      .prepare(
        `INSERT INTO done_card_unread_versions(owner_id,conversation_id,card_key,version) VALUES(?,?,?,1)
    ON CONFLICT(owner_id,conversation_id,card_key) DO UPDATE SET version=version+1 RETURNING version`,
      )
      .get(owner, conversation, key) as { version: number }
  ).version;
}
