import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const profileStatement = statement(
  "SELECT display_name,handle,bio FROM user_profiles WHERE owner_id=?",
);
const profileRow = QueryRecords.user_profiles.pick({
  display_name: true,
  handle: true,
  bio: true,
});
export function profile(db: Database.Database, owner: string) {
  const row = profileStatement(db).get(owner);
  return row === undefined
    ? undefined
    : parseRecord(profileRow, row, "user_profiles");
}

const handleTakenStatement = statement(
  "SELECT 1 FROM user_profiles WHERE handle=? AND owner_id<>?",
);
const handleTakenRow = z.object({ "1": z.number() });
export function handleTaken(
  db: Database.Database,
  handle: string,
  owner: string,
) {
  const row = handleTakenStatement(db).get(handle, owner);
  return row === undefined
    ? undefined
    : parseRecord(handleTakenRow, row, "user_profiles");
}

const saveStatement = statement(
  "INSERT INTO user_profiles(owner_id,display_name,handle,bio,updated_at) VALUES(?,?,?,?,?)\n    ON CONFLICT(owner_id) DO UPDATE SET display_name=excluded.display_name,handle=excluded.handle,bio=excluded.bio,updated_at=excluded.updated_at",
);
export function save(
  db: Database.Database,
  owner: string,
  name: string | null,
  handle: string | null,
  bio: string | null,
  updated: number,
) {
  return saveStatement(db).run(owner, name, handle, bio, updated);
}
