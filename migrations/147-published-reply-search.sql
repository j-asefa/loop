-- Published replies are finished answers even though their message records
-- are public updates. Index only actual publications; ordinary progress and
-- traces remain outside workspace Search.
CREATE TRIGGER reply_search_insert AFTER INSERT ON steering_replies BEGIN
  INSERT OR IGNORE INTO search_documents
  SELECT 'message:'||m.id,m.owner_id,'message',substr(m.content,1,90),m.content,
    c.agent_id,m.conversation_id,NULL,m.created_at,m.created_at
  FROM messages m JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
  WHERE m.id=NEW.message_id AND m.owner_id=NEW.owner_id;
END;

CREATE TRIGGER reply_search_update AFTER UPDATE OF content ON messages
WHEN json_extract(NEW.metadata,'$.progress')=1
  AND EXISTS(SELECT 1 FROM steering_replies p WHERE p.message_id=NEW.id AND p.owner_id=NEW.owner_id)
BEGIN
  UPDATE search_documents SET content=NEW.content,title=substr(NEW.content,1,90),updated_at=unixepoch()*1000
    WHERE id='message:'||NEW.id AND owner_id=NEW.owner_id;
  DELETE FROM embeddings WHERE document_id='message:'||NEW.id AND owner_id=NEW.owner_id;
END;

CREATE TRIGGER reply_search_delete AFTER DELETE ON steering_replies BEGIN
  DELETE FROM search_documents WHERE id='message:'||OLD.message_id AND owner_id=OLD.owner_id
    AND EXISTS(SELECT 1 FROM messages m WHERE m.id=OLD.message_id AND m.owner_id=OLD.owner_id
      AND json_extract(m.metadata,'$.progress')=1);
END;

INSERT OR IGNORE INTO search_documents
SELECT 'message:'||m.id,m.owner_id,'message',substr(m.content,1,90),m.content,
  c.agent_id,m.conversation_id,NULL,m.created_at,m.created_at
FROM steering_replies p JOIN messages m ON m.id=p.message_id AND m.owner_id=p.owner_id
JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id;
