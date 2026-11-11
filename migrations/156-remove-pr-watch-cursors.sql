-- Fresh-install schema: current watches deduplicate through pr_watch_seen.

DROP TABLE pr_watches;

CREATE TABLE pr_watches(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, agent_id TEXT NOT NULL, repo_owner TEXT NOT NULL, repo_name TEXT NOT NULL, number INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'watching', ended_reason TEXT, error TEXT, login TEXT, head_sha TEXT, ci_sha TEXT, ci_conclusion TEXT, next_poll_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, since_at INTEGER, ci_pending INTEGER NOT NULL DEFAULT 0, read_at INTEGER, seen_ci_sha TEXT, seen_ci_conclusion TEXT);

-- Retain current indexes and projection/event triggers.

CREATE INDEX done_watch_expiry ON pr_watches(owner_id,state,updated_at,conversation_id);

CREATE UNIQUE INDEX pr_watches_active ON pr_watches(owner_id, conversation_id, lower(repo_owner), lower(repo_name), number) WHERE state IN ('watching','paused');

CREATE INDEX pr_watches_conversation ON pr_watches(owner_id, conversation_id);

CREATE INDEX pr_watches_due ON pr_watches(state, next_poll_at);

CREATE TRIGGER change_pr_watches_delete BEFORE DELETE ON pr_watches
WHEN OLD.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT OLD.owner_id,NULL,'collection','pulls','tombstone',json_object('scope',json_object('kind','collection','id','pulls'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'),CASE WHEN OLD.conversation_id IS NOT NULL THEN json_object('kind','conversation','id',OLD.conversation_id) ELSE json_object('kind','collection','id','pulls') END),'removed',json_object('kind','conversation','id',OLD.conversation_id)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_pr_watches_insert AFTER INSERT ON pr_watches
WHEN NEW.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'conversation',NEW.conversation_id,'invalidate',json_object('scope',json_object('kind','collection','id','pulls'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'),CASE WHEN NEW.conversation_id IS NOT NULL THEN json_object('kind','conversation','id',NEW.conversation_id) ELSE json_object('kind','collection','id','pulls') END)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_pr_watches_update AFTER UPDATE ON pr_watches
WHEN NEW.owner_id IS NOT NULL AND (OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.conversation_id IS NOT NEW.conversation_id OR OLD.agent_id IS NOT NEW.agent_id OR OLD.repo_owner IS NOT NEW.repo_owner OR OLD.repo_name IS NOT NEW.repo_name OR OLD.number IS NOT NEW.number OR OLD.state IS NOT NEW.state OR OLD.ended_reason IS NOT NEW.ended_reason OR OLD.error IS NOT NEW.error OR OLD.login IS NOT NEW.login OR OLD.head_sha IS NOT NEW.head_sha OR OLD.ci_sha IS NOT NEW.ci_sha OR OLD.ci_conclusion IS NOT NEW.ci_conclusion OR OLD.created_at IS NOT NEW.created_at OR OLD.updated_at IS NOT NEW.updated_at OR OLD.since_at IS NOT NEW.since_at OR OLD.ci_pending IS NOT NEW.ci_pending OR OLD.read_at IS NOT NEW.read_at OR OLD.seen_ci_sha IS NOT NEW.seen_ci_sha OR OLD.seen_ci_conclusion IS NOT NEW.seen_ci_conclusion)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'conversation',NEW.conversation_id,'invalidate',json_object('scope',json_object('kind','collection','id','pulls'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'),CASE WHEN NEW.conversation_id IS NOT NULL THEN json_object('kind','conversation','id',NEW.conversation_id) ELSE json_object('kind','collection','id','pulls') END)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_watch_expiry_delete BEFORE DELETE ON pr_watches BEGIN
 DELETE FROM change_expiries WHERE owner_id=OLD.owner_id AND kind='watch' AND subject_id=OLD.id;
END;

CREATE TRIGGER change_watch_expiry_insert AFTER INSERT ON pr_watches WHEN NEW.state NOT IN ('watching','paused') BEGIN
 INSERT INTO change_expiries(owner_id,kind,subject_id,expires_at)
 SELECT owner_id,'watch',id,updated_at+604800000 FROM pr_watches WHERE id=NEW.id AND state NOT IN ('watching','paused')
 ON CONFLICT(owner_id,kind,subject_id) DO UPDATE SET expires_at=excluded.expires_at,
 processed=CASE WHEN change_expiries.expires_at=excluded.expires_at THEN change_expiries.processed ELSE 0 END;
END;

CREATE TRIGGER change_watch_expiry_update AFTER UPDATE OF owner_id,state,updated_at ON pr_watches
WHEN OLD.owner_id IS NOT NEW.owner_id OR OLD.state IS NOT NEW.state OR OLD.updated_at IS NOT NEW.updated_at BEGIN
 DELETE FROM change_expiries WHERE owner_id=OLD.owner_id AND kind='watch' AND subject_id=OLD.id;
 INSERT INTO change_expiries(owner_id,kind,subject_id,expires_at)
 SELECT owner_id,'watch',id,updated_at+604800000 FROM pr_watches WHERE id=NEW.id AND state NOT IN ('watching','paused')
 ON CONFLICT(owner_id,kind,subject_id) DO UPDATE SET expires_at=excluded.expires_at,
 processed=CASE WHEN change_expiries.expires_at=excluded.expires_at THEN change_expiries.processed ELSE 0 END;
END;

CREATE TRIGGER done_pr_watches_delete AFTER DELETE ON pr_watches BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',key,owner_id,0 FROM (SELECT key,owner_id FROM done_card_candidates WHERE owner_id=old.owner_id AND conversation_id=old.conversation_id) WHERE key IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_pr_watches_insert AFTER INSERT ON pr_watches BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',key,owner_id,0 FROM (SELECT key,owner_id FROM done_card_candidates WHERE owner_id=new.owner_id AND conversation_id=new.conversation_id) WHERE key IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_pr_watches_update AFTER UPDATE ON pr_watches WHEN new.conversation_id IS NOT old.conversation_id OR new.owner_id IS NOT old.owner_id OR new.repo_owner IS NOT old.repo_owner OR new.repo_name IS NOT old.repo_name OR new.number IS NOT old.number OR new.state IS NOT old.state OR new.ended_reason IS NOT old.ended_reason OR new.error IS NOT old.error OR new.head_sha IS NOT old.head_sha OR new.ci_sha IS NOT old.ci_sha OR new.ci_conclusion IS NOT old.ci_conclusion OR new.ci_pending IS NOT old.ci_pending OR new.read_at IS NOT old.read_at OR new.seen_ci_sha IS NOT old.seen_ci_sha OR new.seen_ci_conclusion IS NOT old.seen_ci_conclusion OR new.created_at IS NOT old.created_at OR (new.state='stopped' AND new.updated_at IS NOT old.updated_at) BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',key,owner_id,0 FROM (SELECT key,owner_id FROM done_card_candidates WHERE owner_id=old.owner_id AND conversation_id=old.conversation_id) WHERE key IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',key,owner_id,0 FROM (SELECT key,owner_id FROM done_card_candidates WHERE owner_id=new.owner_id AND conversation_id=new.conversation_id) WHERE key IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER project_feed_pr_watches_delete BEFORE DELETE ON pr_watches BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT OLD.owner_id,OLD.conversation_id,'' WHERE OLD.owner_id IS NOT NULL AND OLD.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_pr_watches_insert AFTER INSERT ON pr_watches BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT NEW.owner_id,NEW.conversation_id,'' WHERE NEW.owner_id IS NOT NULL AND NEW.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_pr_watches_update AFTER UPDATE OF id,owner_id,conversation_id,repo_owner,repo_name,number,state,ended_reason,error,head_sha,ci_sha,ci_conclusion,ci_pending,read_at,seen_ci_sha,seen_ci_conclusion,created_at,updated_at ON pr_watches WHEN OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.conversation_id IS NOT NEW.conversation_id OR OLD.repo_owner IS NOT NEW.repo_owner OR OLD.repo_name IS NOT NEW.repo_name OR OLD.number IS NOT NEW.number OR OLD.state IS NOT NEW.state OR OLD.ended_reason IS NOT NEW.ended_reason OR OLD.error IS NOT NEW.error OR OLD.head_sha IS NOT NEW.head_sha OR OLD.ci_sha IS NOT NEW.ci_sha OR OLD.ci_conclusion IS NOT NEW.ci_conclusion OR OLD.ci_pending IS NOT NEW.ci_pending OR OLD.read_at IS NOT NEW.read_at OR OLD.seen_ci_sha IS NOT NEW.seen_ci_sha OR OLD.seen_ci_conclusion IS NOT NEW.seen_ci_conclusion OR OLD.created_at IS NOT NEW.created_at OR OLD.updated_at IS NOT NEW.updated_at BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT OLD.owner_id,OLD.conversation_id,'' WHERE OLD.owner_id IS NOT NULL AND OLD.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT NEW.owner_id,NEW.conversation_id,'' WHERE NEW.owner_id IS NOT NULL AND NEW.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;
