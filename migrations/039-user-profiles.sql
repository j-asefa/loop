-- The signed-in person's own profile, shown on the You page. The name falls
-- back to the account's name when not set; the handle is unique across
-- owners (lower case, so the check is case-insensitive).
CREATE TABLE user_profiles(owner_id TEXT PRIMARY KEY, display_name TEXT, handle TEXT, bio TEXT, updated_at INTEGER NOT NULL);
CREATE UNIQUE INDEX user_profiles_handle ON user_profiles(handle) WHERE handle IS NOT NULL;
INSERT INTO schema_version VALUES(39,unixepoch()*1000);
