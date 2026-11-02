import * as agentsQueries from "./sql/agents.js";
import * as foldersQueries from "./sql/folders.js";
import * as userProfilesQueries from "./sql/user-profiles.js";
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
  const row = userProfilesQueries.profile(db, owner) as ProfileRow | undefined;
  return {
    display_name: row?.display_name ?? null,
    handle: row?.handle ?? null,
    bio: row?.bio ?? null,
    counts: {
      messages: personalPromptCount(owner),
      agents: agentsQueries.activeProfileCount(db, owner)!.n,
      projects: foldersQueries.rootProjectCount(db, owner)!.n,
    },
  };
}

export function saveProfile(owner: string, input: unknown) {
  const profile = ProfileInput.parse(input);
  if (
    profile.handle &&
    userProfilesQueries.handleTaken(db, profile.handle, owner)
  )
    throw new Problem(409, "That handle is taken. Choose another.");
  userProfilesQueries.save(
    db,
    owner,
    profile.display_name,
    profile.handle,
    profile.bio,
    now(),
  );
  return readProfile(owner);
}
