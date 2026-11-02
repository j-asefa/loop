import type Database from "better-sqlite3";
import { z } from "zod";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";
const epochStatement = statement(
  "SELECT epoch FROM card_revision_domain WHERE singleton=1",
);
const epochRow = z.object({ epoch: z.string() });
export function epoch(db: Database.Database) {
  return parseRecord(
    epochRow,
    epochStatement(db).get(),
    "card_revision_domain",
  );
}
