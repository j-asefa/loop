-- Display links are independent of automatic follow-ups and GitHub credentials.
CREATE TABLE conversation_pull_links (
  owner_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  repo_owner TEXT NOT NULL COLLATE NOCASE,
  repo_name TEXT NOT NULL COLLATE NOCASE,
  number INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id, conversation_id, repo_owner, repo_name, number)
);

CREATE TRIGGER change_conversation_pull_links_insert AFTER INSERT ON conversation_pull_links BEGIN
  INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
  VALUES(NEW.owner_id,NULL,'conversation',NEW.conversation_id,'invalidate',
    json_object('scope',json_object('kind','collection','id','pulls'),
      'scopes',json_array(json_object('kind','collection','id','pulls'),json_object('kind','conversation','id',NEW.conversation_id))),
    unixepoch('subsec')*1000);
END;
