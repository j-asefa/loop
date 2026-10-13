-- What Loop observed in a native agent's worktree at the start and end of a
-- run. Loop captures it with read-only Git; the harness reports nothing. One
-- record per run. The patch is stored at capture time, bounded, so a citation
-- never resolves to a later state of the checkout. Dismissing a Done card
-- does not touch it; deleting the run does.
CREATE TABLE run_checkouts(
  id TEXT PRIMARY KEY,                       -- citation ref is 'chk_' || id
  owner_id TEXT NOT NULL,
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  generation TEXT,                           -- companion session generation at start
  directory TEXT NOT NULL,                   -- the agent's worktree project directory
  source TEXT NOT NULL,                      -- the project checkout the worktree was made from
  branch TEXT NOT NULL,
  base_ref TEXT,                             -- the source checkout's branch, as observed
  base_sha TEXT,                             -- merge-base with the source head at the latest capture
  start_head TEXT NOT NULL,
  start_dirty INTEGER NOT NULL,              -- tracked changes already present before the run
  start_untracked INTEGER NOT NULL,          -- untracked files already present before the run
  started_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('started','captured','failed')),
  end_head TEXT,
  ahead INTEGER, behind INTEGER,             -- commits relative to the source head
  files TEXT,                                -- JSON [{path,additions,deletions,binary}] of base..working tree
  committed TEXT,                            -- JSON {files,additions,deletions} of base..HEAD
  working TEXT,                              -- JSON {files,additions,deletions} of HEAD..working tree (tracked)
  untracked TEXT,                            -- JSON [path]
  patch TEXT, patch_bytes INTEGER, patch_truncated INTEGER,
  remote TEXT,                               -- JSON {ref,sha,contains_head,observed_at}; null when no remote ref was seen
  overlap TEXT,                              -- JSON [run id] other runs active on this checkout during this one
  captured_late INTEGER NOT NULL DEFAULT 0,  -- captured after a restart, later than the run ended
  capture_token TEXT,                        -- the capture in flight; one per run across processes
  capture_started_at INTEGER,
  capture_pending INTEGER NOT NULL DEFAULT 0,-- a later request arrived while a capture was in flight
  summary TEXT,                              -- JSON card summary, derived from the columns above
  ended_at INTEGER,
  error TEXT
);
CREATE INDEX run_checkouts_conversation ON run_checkouts(owner_id, conversation_id, started_at);

INSERT INTO schema_version VALUES(85,unixepoch()*1000);
