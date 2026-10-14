-- Verification commands Loop observed an agent run: tests, type checks and
-- lints, with the exit Loop saw. An observation of a command's outcome, not
-- the agent's account of it. Failures, unknown exits and truncated output
-- are kept; a passing chain is a chain whose every command exited zero.
CREATE TABLE run_verifications(
  id TEXT PRIMARY KEY,                       -- citation ref is 'ver_' || id
  owner_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  conversation_id TEXT,
  generation TEXT,                           -- native session generation that reported it
  kind TEXT NOT NULL CHECK(kind IN ('test','typecheck','lint')),
  tools TEXT NOT NULL,                       -- JSON [tool]: the verification tools in the command
  command TEXT NOT NULL,                     -- the command as reported, bounded
  status TEXT NOT NULL CHECK(status IN ('passed','failed','unknown')),
  exit_code INTEGER,
  truncated INTEGER NOT NULL DEFAULT 0,      -- output was cut before Loop saw all of it
  output_tail TEXT,                          -- the last part of the output, bounded
  observed_at INTEGER NOT NULL
);
CREATE INDEX run_verifications_run ON run_verifications(owner_id, run_id, observed_at);

INSERT INTO schema_version VALUES(86,unixepoch()*1000);
