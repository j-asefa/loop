CREATE TABLE memory_policy(owner_id TEXT NOT NULL,scope TEXT NOT NULL,enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),PRIMARY KEY(owner_id,scope));
CREATE TABLE memory_sources (
 id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,project_id TEXT,kind TEXT NOT NULL,source_id TEXT NOT NULL,
 conversation_id TEXT,message_id TEXT,agent_id TEXT,origin TEXT NOT NULL,role TEXT NOT NULL,
 revision INTEGER NOT NULL,content_hash TEXT NOT NULL,content TEXT NOT NULL,title TEXT NOT NULL,
 eligible INTEGER NOT NULL,tombstone INTEGER NOT NULL DEFAULT 0,complete INTEGER NOT NULL DEFAULT 1,
 created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,indexed_revision INTEGER,
 UNIQUE(owner_id,kind,source_id)
);
CREATE TABLE memory_note_versions(source_id TEXT NOT NULL REFERENCES memory_sources(id),revision INTEGER NOT NULL,title TEXT NOT NULL,content TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(source_id,revision));
CREATE TABLE memory_outbox(source_id TEXT PRIMARY KEY REFERENCES memory_sources(id),revision INTEGER NOT NULL,action TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0);
CREATE TABLE memory_receipts(run_id TEXT PRIMARY KEY REFERENCES runs(id),mode TEXT NOT NULL,sources TEXT NOT NULL,tokens INTEGER NOT NULL,created_at INTEGER NOT NULL);
CREATE VIRTUAL TABLE memory_fts USING fts5(id UNINDEXED,owner_id UNINDEXED,title,content,tokenize='unicode61');
CREATE TRIGGER memory_insert AFTER INSERT ON memory_sources BEGIN INSERT INTO memory_fts VALUES(new.id,new.owner_id,new.title,new.content); END;
CREATE TRIGGER memory_update AFTER UPDATE ON memory_sources BEGIN DELETE FROM memory_fts WHERE id=old.id; INSERT INTO memory_fts VALUES(new.id,new.owner_id,new.title,new.content); END;
CREATE TABLE artifact_objects(artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id),owner_id TEXT NOT NULL,run_id TEXT NOT NULL,call_id TEXT NOT NULL,object_key TEXT NOT NULL UNIQUE,mime TEXT NOT NULL,size INTEGER NOT NULL,checksum TEXT NOT NULL,UNIQUE(run_id,call_id));
INSERT INTO schema_version VALUES(28,unixepoch()*1000);
