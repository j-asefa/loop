-- Keep create identities after ungrouping, so a retried request cannot recreate it.
CREATE TABLE done_thread_creations (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL
);
CREATE TABLE done_threads (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(owner_id,id)
);
CREATE TABLE done_thread_members (
  owner_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  PRIMARY KEY(owner_id,card_id),
  FOREIGN KEY(owner_id,thread_id) REFERENCES done_threads(owner_id,id) ON DELETE CASCADE
);
CREATE INDEX done_threads_owner ON done_threads(owner_id,created_at);
CREATE INDEX done_thread_members_thread ON done_thread_members(owner_id,thread_id);
