-- Projection revisions belong to durable message identities, including hidden
-- commentary. All rows and their events commit together in the writer's transaction.
ALTER TABLE messages ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
CREATE VIEW message_projection AS
SELECT m.id,m.owner_id,m.conversation_id,m.run_id,m.role,m.content,m.created_at,m.revision,
 json_set(m.metadata,'$.completedMessageId',(SELECT final.id FROM messages final
   WHERE final.owner_id=m.owner_id AND final.run_id=m.run_id AND final.update_key IS NOT NULL
     AND json_extract(final.metadata,'$.final')=1 ORDER BY final.rowid DESC LIMIT 1),
   '$.delivery',s.state,'$.deliveryError',s.error) metadata,
 r.state run_state,r.error run_error,
 (SELECT k.summary FROM run_checkouts k WHERE k.run_id=m.run_id AND k.owner_id=m.owner_id) run_checkout,
 (SELECT json_group_array(json_object('id',v.id,'kind',v.kind,'tools',json(v.tools),'status',v.status))
   FROM run_verifications v WHERE v.run_id=m.run_id AND v.owner_id=m.owner_id) run_verification,
 e.position,e.phase,e.ordinal,e.visible
FROM messages m JOIN transcript_message_entries e ON e.message_id=m.id
LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id
LEFT JOIN run_steering s ON s.message_id=m.id AND s.owner_id=m.owner_id;

-- Keep oversized replacements scoped before the transport's payload cap. The
-- source row remains complete; its durable event requests that row instead of
-- duplicating an unbounded body on every metadata/run-state change. Reserve
-- space for the wire envelope, and keep NULL run_id so deletion cannot cascade
-- away the projection's recovery event.
CREATE TRIGGER projection_event_bound AFTER INSERT ON events
WHEN length(CAST(NEW.payload AS BLOB))>60*1024 AND
 CASE WHEN json_valid(NEW.payload) THEN
   (NEW.subject_kind='message' AND NEW.type='message.upsert' AND
    json_type(NEW.payload,'$.message.conversation_id')='text') OR
   (NEW.subject_kind='decision' AND NEW.type LIKE 'decision.%')
 ELSE 0 END
BEGIN
 UPDATE events SET type='invalidate',payload=
   CASE WHEN NEW.subject_kind='message' THEN
     json_object('scope',json_object('kind','conversation','id',json_extract(NEW.payload,'$.message.conversation_id')))
   ELSE json_object('scope',json_object('kind','collection','id','decisions')) END
 WHERE id=NEW.id;
END;

DROP TRIGGER transcript_message_insert;
CREATE TRIGGER transcript_message_insert AFTER INSERT ON messages BEGIN
  INSERT INTO transcript_message_sequences(message_id) VALUES(NEW.id);
  INSERT INTO conversation_transcript
  SELECT ordinal,owner_id,conversation_id,run_id,message_id,position,phase
  FROM transcript_message_entries WHERE message_id=NEW.id AND visible;
  UPDATE conversation_transcript SET position=(
    SELECT e.position FROM transcript_message_entries e WHERE e.message_id=conversation_transcript.message_id)
  WHERE owner_id=NEW.owner_id AND run_id=NEW.run_id
    AND json_extract(NEW.metadata,'$.progress') IS NOT 1;
INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT v.owner_id,NULL,'message',v.id,
   CASE WHEN v.visible THEN 'message.upsert' ELSE 'message.remove' END,
   CASE WHEN v.visible THEN json_object('message',json_object('id',v.id,'owner_id',v.owner_id,'conversation_id',v.conversation_id,'run_id',v.run_id,'role',v.role,'content',v.content,'metadata',v.metadata,'created_at',v.created_at,'run_state',v.run_state,'run_error',v.run_error,'run_checkout',v.run_checkout,'run_verification',v.run_verification,'revision',v.revision,'cursor',json_array(v.position,v.phase,v.ordinal)))
     ELSE json_object('messageId',v.id,'conversationId',v.conversation_id,'revision',v.revision) END,
   unixepoch('subsec')*1000
 FROM message_projection v WHERE v.id=NEW.id AND (1);
END;

DROP TRIGGER transcript_message_update;
CREATE TRIGGER transcript_message_update
AFTER UPDATE OF owner_id,conversation_id,run_id,role,content,metadata,created_at ON messages BEGIN
  UPDATE messages SET revision=OLD.revision+1 WHERE id=NEW.id;
  DELETE FROM conversation_transcript WHERE message_id=NEW.id;
  INSERT INTO conversation_transcript
  SELECT ordinal,owner_id,conversation_id,run_id,message_id,position,phase
  FROM transcript_message_entries WHERE message_id=NEW.id AND visible;
INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT v.owner_id,NULL,'message',v.id,
   CASE WHEN v.visible THEN 'message.upsert' ELSE 'message.remove' END,
   CASE WHEN v.visible THEN json_object('message',json_object('id',v.id,'owner_id',v.owner_id,'conversation_id',v.conversation_id,'run_id',v.run_id,'role',v.role,'content',v.content,'metadata',v.metadata,'created_at',v.created_at,'run_state',v.run_state,'run_error',v.run_error,'run_checkout',v.run_checkout,'run_verification',v.run_verification,'revision',v.revision,'cursor',json_array(v.position,v.phase,v.ordinal)))
     ELSE json_object('messageId',v.id,'conversationId',v.conversation_id,'revision',v.revision) END,
   unixepoch('subsec')*1000
 FROM message_projection v WHERE v.id=NEW.id AND (NOT (instr(NEW.content,char(0))=0 AND instr(OLD.content,char(0))=0 AND length(trim(OLD.content))>0 AND substr(NEW.content,1,length(OLD.content))=OLD.content AND length(NEW.content)>length(OLD.content) AND OLD.metadata=NEW.metadata AND OLD.role=NEW.role AND OLD.conversation_id=NEW.conversation_id AND OLD.run_id IS NEW.run_id AND OLD.created_at=NEW.created_at AND OLD.owner_id=NEW.owner_id) OR NOT v.visible);
 -- Each bounded chunk is its own durable event. Reconnect can acknowledge each
 -- whole event; no cursor ever passes a partially delivered event. SQL substr
 -- splits at Unicode code points; offsets count UTF-8 bytes, not JS characters.
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 WITH RECURSIVE chunks(n) AS (
   SELECT 0 WHERE instr(NEW.content,char(0))=0 AND instr(OLD.content,char(0))=0 AND length(trim(OLD.content))>0 AND substr(NEW.content,1,length(OLD.content))=OLD.content AND length(NEW.content)>length(OLD.content) AND OLD.metadata=NEW.metadata AND OLD.role=NEW.role AND OLD.conversation_id=NEW.conversation_id AND OLD.run_id IS NEW.run_id AND OLD.created_at=NEW.created_at AND OLD.owner_id=NEW.owner_id
   UNION ALL SELECT n+1 FROM chunks
     WHERE (n+1)*8192<length(NEW.content)-length(OLD.content)
 )
 SELECT NEW.owner_id,NULL,'message',NEW.id,'message.delta',
   json_object('messageId',NEW.id,'conversationId',NEW.conversation_id,
     'revision',OLD.revision+1,'baseRevision',CASE WHEN n=0 THEN OLD.revision ELSE OLD.revision+1 END,
     'offset',length(CAST(substr(NEW.content,1,length(OLD.content)+n*8192) AS BLOB)),
     'chunkIndex',0,'text',substr(NEW.content,length(OLD.content)+n*8192+1,8192)),
   unixepoch('subsec')*1000
 FROM chunks WHERE (SELECT visible FROM message_projection WHERE id=NEW.id);

END;

CREATE TRIGGER projection_message_delete BEFORE DELETE ON messages BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 VALUES(OLD.owner_id,NULL,'message',OLD.id,'message.remove',
   json_object('messageId',OLD.id,'conversationId',OLD.conversation_id,'revision',OLD.revision+1),unixepoch('subsec')*1000);
END;

-- State/delivery/verification enrich the displayed row independently of content.
-- Re-run the canonical projection trigger and advance its revision in the same
-- transaction, including aggregate final-answer visibility.
CREATE TRIGGER projection_run_state AFTER UPDATE OF state,error ON runs
WHEN OLD.state IS NOT NEW.state OR OLD.error IS NOT NEW.error BEGIN
 UPDATE messages SET metadata=metadata WHERE run_id=NEW.id AND owner_id=NEW.owner_id;
END;
CREATE TRIGGER projection_message_final AFTER UPDATE OF metadata ON messages
WHEN json_extract(OLD.metadata,'$.final') IS NOT json_extract(NEW.metadata,'$.final') BEGIN
 UPDATE messages SET metadata=metadata WHERE run_id=NEW.run_id AND owner_id=NEW.owner_id
   AND id<>NEW.id AND update_key IS NULL;
END;
CREATE TRIGGER projection_run_steering_insert AFTER INSERT ON run_steering BEGIN
 UPDATE messages SET metadata=metadata WHERE run_id=NEW.run_id AND owner_id=NEW.owner_id;
END;
CREATE TRIGGER projection_run_steering_update AFTER UPDATE OF state,error ON run_steering BEGIN
 UPDATE messages SET metadata=metadata WHERE run_id=NEW.run_id AND owner_id=NEW.owner_id;
END;
CREATE TRIGGER projection_run_steering_delete AFTER DELETE ON run_steering BEGIN
 UPDATE messages SET metadata=metadata WHERE run_id=OLD.run_id AND owner_id=OLD.owner_id;
END;
CREATE TRIGGER projection_run_checkouts_insert AFTER INSERT ON run_checkouts BEGIN
 UPDATE messages SET metadata=metadata WHERE run_id=NEW.run_id AND owner_id=NEW.owner_id;
END;
CREATE TRIGGER projection_run_checkouts_update AFTER UPDATE OF summary ON run_checkouts BEGIN
 UPDATE messages SET metadata=metadata WHERE run_id=NEW.run_id AND owner_id=NEW.owner_id;
END;
CREATE TRIGGER projection_run_checkouts_delete AFTER DELETE ON run_checkouts BEGIN
 UPDATE messages SET metadata=metadata WHERE run_id=OLD.run_id AND owner_id=OLD.owner_id;
END;
CREATE TRIGGER projection_run_verifications_insert AFTER INSERT ON run_verifications BEGIN
 UPDATE messages SET metadata=metadata WHERE run_id=NEW.run_id AND owner_id=NEW.owner_id;
END;
CREATE TRIGGER projection_run_verifications_update AFTER UPDATE OF status,tools,kind ON run_verifications BEGIN
 UPDATE messages SET metadata=metadata WHERE run_id=NEW.run_id AND owner_id=NEW.owner_id;
END;
CREATE TRIGGER projection_run_verifications_delete AFTER DELETE ON run_verifications BEGIN
 UPDATE messages SET metadata=metadata WHERE run_id=OLD.run_id AND owner_id=OLD.owner_id;
END;
CREATE TRIGGER projection_decision_insert AFTER INSERT ON native_decisions

 BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT r.owner_id,NULL,'decision',NEW.id,'decision.'||NEW.state,
   json_object('decisionId',NEW.id,'conversationId',NEW.conversation_id,'runId',NEW.run_id,
     'generation',NEW.generation,'nativeId',NEW.native_id,'state',NEW.state,'request',json(NEW.request)),unixepoch('subsec')*1000
 FROM runs r WHERE r.id=NEW.run_id;
END;
CREATE TRIGGER projection_decision_update AFTER UPDATE ON native_decisions
 WHEN OLD.state IS NOT NEW.state OR OLD.request IS NOT NEW.request
 BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT r.owner_id,NULL,'decision',NEW.id,'decision.'||NEW.state,
   json_object('decisionId',NEW.id,'conversationId',NEW.conversation_id,'runId',NEW.run_id,
     'generation',NEW.generation,'nativeId',NEW.native_id,'state',NEW.state,'request',json(NEW.request)),unixepoch('subsec')*1000
 FROM runs r WHERE r.id=NEW.run_id;
END;
CREATE TRIGGER projection_decision_delete BEFORE DELETE ON native_decisions

 BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT r.owner_id,NULL,'decision',OLD.id,'decision.remove',
   json_object('decisionId',OLD.id,'conversationId',OLD.conversation_id,'runId',OLD.run_id,
     'generation',OLD.generation,'nativeId',OLD.native_id,'state',OLD.state,'request',json(OLD.request)),unixepoch('subsec')*1000
 FROM runs r WHERE r.id=OLD.run_id;
END;


-- Derived Feed activity is not a workspace metadata change.
DROP TRIGGER change_conversations_update;
CREATE TRIGGER change_conversations_update AFTER UPDATE ON conversations
WHEN NEW.owner_id IS NOT NULL AND (OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.agent_id IS NOT NEW.agent_id OR OLD.title IS NOT NEW.title OR OLD.origin IS NOT NEW.origin OR OLD.external_id IS NOT NEW.external_id OR OLD.created_at IS NOT NEW.created_at OR OLD.team_id IS NOT NEW.team_id OR OLD.execution_backend IS NOT NEW.execution_backend OR OLD.execution_connection_id IS NOT NEW.execution_connection_id OR OLD.project_id IS NOT NEW.project_id OR OLD.feed_hidden IS NOT NEW.feed_hidden OR OLD.feed_run_id IS NOT NEW.feed_run_id OR OLD.feed_run_raw_state IS NOT NEW.feed_run_raw_state OR OLD.feed_run_state IS NOT NEW.feed_run_state OR OLD.feed_run_dismissed_at IS NOT NEW.feed_run_dismissed_at OR OLD.feed_queued IS NOT NEW.feed_queued OR OLD.feed_done_run_id IS NOT NEW.feed_done_run_id OR OLD.feed_done_at IS NOT NEW.feed_done_at OR OLD.feed_last_activity_at IS NOT NEW.feed_last_activity_at OR OLD.feed_last_message_id IS NOT NEW.feed_last_message_id OR OLD.feed_folder_id IS NOT NEW.feed_folder_id OR OLD.feed_visible IS NOT NEW.feed_visible OR OLD.feed_approval_until IS NOT NEW.feed_approval_until)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'conversation',NEW.id,'invalidate',json_object('scope',json_object('kind','collection','id','feed'),'scopes',json_array(json_object('kind','collection','id','later'),json_object('kind','collection','id','results'),json_object('kind','collection','id','saved'),json_object('kind','collection','id',CASE WHEN OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.agent_id IS NOT NEW.agent_id OR OLD.title IS NOT NEW.title OR OLD.origin IS NOT NEW.origin OR OLD.external_id IS NOT NEW.external_id OR OLD.created_at IS NOT NEW.created_at OR OLD.team_id IS NOT NEW.team_id OR OLD.execution_backend IS NOT NEW.execution_backend OR OLD.execution_connection_id IS NOT NEW.execution_connection_id OR OLD.project_id IS NOT NEW.project_id THEN 'metadata' ELSE 'feed' END),CASE WHEN NEW.id IS NOT NULL THEN json_object('kind','conversation','id',NEW.id) ELSE json_object('kind','collection','id','feed') END)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER projection_position AFTER UPDATE OF position,phase,ordinal ON conversation_transcript
WHEN OLD.position IS NOT NEW.position OR OLD.phase IS NOT NEW.phase OR OLD.ordinal IS NOT NEW.ordinal BEGIN
 UPDATE messages SET metadata=metadata WHERE id=NEW.message_id;
END;


-- Conversation memory preferences can change from another device.
CREATE TRIGGER projection_memory_policy_insert AFTER INSERT ON memory_policy
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 VALUES(NEW.owner_id,NULL,'collection','metadata','invalidate',json_object('scope',json_object('kind','collection','id','metadata')),unixepoch('subsec')*1000);
END;
CREATE TRIGGER projection_memory_policy_update AFTER UPDATE ON memory_policy
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 VALUES(NEW.owner_id,NULL,'collection','metadata','invalidate',json_object('scope',json_object('kind','collection','id','metadata')),unixepoch('subsec')*1000);
END;
CREATE TRIGGER projection_memory_policy_delete AFTER DELETE ON memory_policy
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 VALUES(OLD.owner_id,NULL,'collection','metadata','invalidate',json_object('scope',json_object('kind','collection','id','metadata')),unixepoch('subsec')*1000);
END;

INSERT INTO schema_version VALUES(121,unixepoch()*1000);
