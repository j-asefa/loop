import * as doneCardUnreadVersionsQueries from "./sql/done-card-unread-versions.js";
import { db } from "./db.js";

export function doneUnreadVersion(
  owner: string,
  conversation: string,
  key: string,
) {
  return (
    doneCardUnreadVersionsQueries.version(db, owner, conversation, key)
      ?.version ?? 0
  );
}

/** The owning card/group mutation validates access and holds the transaction. */
export function advanceDoneUnreadVersion(
  owner: string,
  conversation: string,
  key: string,
) {
  return (
    doneCardUnreadVersionsQueries.advance(db, owner, conversation, key) as {
      version: number;
    }
  ).version;
}
