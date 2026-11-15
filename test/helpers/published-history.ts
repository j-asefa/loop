import type Database from "better-sqlite3";
import { sealUnpublishedAnswers } from "../../src/server/result-history";

// Fixtures that insert completed runs and answers with SQL describe history
// as released builds stored it, before Results existed. Done and Replies
// read only sealed Results, so such fixtures seal that history through the
// production upgrade path before reading it. Already sealed Results are kept.
export function sealSeededHistory(db: Database.Database) {
  db.transaction(() => sealUnpublishedAnswers(db)).immediate();
}
