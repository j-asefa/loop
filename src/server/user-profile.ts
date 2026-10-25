import { ProfileInput } from "../shared/personal-schemas.js";
import { db, now } from "./db.js";
import { Problem } from "./domain.js";
import { personalPromptCount } from "./personal-history.js";

type ProfileRow = {
  display_name: string | null;
  handle: string | null;
  bio: string | null;
};

// The owner comes from authentication; a profile is only ever read or
// written for that owner.
export function readProfile(owner: string) {
  const row = db
    .prepare(
      "SELECT display_name,handle,bio FROM user_profiles WHERE owner_id=?",
    )
    .get(owner) as ProfileRow | undefined;
  const count = (sql: string) =>
    (db.prepare(sql).get(owner) as { n: number }).n;
  return {
    display_name: row?.display_name ?? null,
    handle: row?.handle ?? null,
    bio: row?.bio ?? null,
    counts: {
      messages: personalPromptCount(owner),
      agents: count(
        "SELECT count(*) n FROM agents WHERE owner_id=? AND retired_at IS NULL",
      ),
      projects: count(
        "SELECT count(*) n FROM folders WHERE owner_id=? AND kind='project' AND parent_id IS NULL",
      ),
    },
  };
}

export function saveProfile(owner: string, input: unknown) {
  const profile = ProfileInput.parse(input);
  if (
    profile.handle &&
    db
      .prepare("SELECT 1 FROM user_profiles WHERE handle=? AND owner_id<>?")
      .get(profile.handle, owner)
  )
    throw new Problem(409, "That handle is taken. Choose another.");
  db.prepare(
    `INSERT INTO user_profiles(owner_id,display_name,handle,bio,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(owner_id) DO UPDATE SET display_name=excluded.display_name,handle=excluded.handle,bio=excluded.bio,updated_at=excluded.updated_at`,
  ).run(owner, profile.display_name, profile.handle, profile.bio, now());
  return readProfile(owner);
}
