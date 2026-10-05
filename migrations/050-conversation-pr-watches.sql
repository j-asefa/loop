-- Each conversation owns its PR follow-ups, including when another thread watches it.
DROP INDEX pr_watches_active;
CREATE UNIQUE INDEX pr_watches_active ON pr_watches(owner_id, conversation_id, lower(repo_owner), lower(repo_name), number) WHERE state IN ('watching','paused');
INSERT INTO schema_version VALUES(50,unixepoch()*1000);
