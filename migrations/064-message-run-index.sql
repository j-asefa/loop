-- A transcript page groups every entry under the run's first prompt, so each
-- row resolves min(rowid) over its run's user messages. Without an index on
-- run_id, SQLite fell back to the owner's whole user-message history for every
-- row: one page cost (conversation rows) x (account prompts), which is why
-- long-lived agents loaded slowly while short ones stayed fast. role is in the
-- index so the lookup stays covering, and owner_id leads to keep profiles
-- separable; run_id-only probes still skip-scan it.
CREATE INDEX IF NOT EXISTS messages_run ON messages(owner_id,run_id,role);
INSERT INTO schema_version VALUES(64,unixepoch()*1000);
