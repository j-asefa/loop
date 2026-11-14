-- Retain historical watch rows, dependent history and inert cursor values.
-- Runtime behavior no longer uses these cursors. Only the change trigger
-- needs to stop treating them as current state; no table rebuild is needed.
DROP TRIGGER change_pr_watches_update;

CREATE TRIGGER change_pr_watches_update AFTER UPDATE ON pr_watches
WHEN NEW.owner_id IS NOT NULL AND (OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.conversation_id IS NOT NEW.conversation_id OR OLD.agent_id IS NOT NEW.agent_id OR OLD.repo_owner IS NOT NEW.repo_owner OR OLD.repo_name IS NOT NEW.repo_name OR OLD.number IS NOT NEW.number OR OLD.state IS NOT NEW.state OR OLD.ended_reason IS NOT NEW.ended_reason OR OLD.error IS NOT NEW.error OR OLD.login IS NOT NEW.login OR OLD.head_sha IS NOT NEW.head_sha OR OLD.ci_sha IS NOT NEW.ci_sha OR OLD.ci_conclusion IS NOT NEW.ci_conclusion OR OLD.created_at IS NOT NEW.created_at OR OLD.updated_at IS NOT NEW.updated_at OR OLD.since_at IS NOT NEW.since_at OR OLD.ci_pending IS NOT NEW.ci_pending OR OLD.read_at IS NOT NEW.read_at OR OLD.seen_ci_sha IS NOT NEW.seen_ci_sha OR OLD.seen_ci_conclusion IS NOT NEW.seen_ci_conclusion)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'conversation',NEW.conversation_id,'invalidate',json_object('scope',json_object('kind','collection','id','pulls'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'),CASE WHEN NEW.conversation_id IS NOT NULL THEN json_object('kind','conversation','id',NEW.conversation_id) ELSE json_object('kind','collection','id','pulls') END)),unixepoch('subsec')*1000;
END;
