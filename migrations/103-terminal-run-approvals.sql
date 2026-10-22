-- A stopped run cannot answer a pending approval. Close only requests that
-- were never approved; executing/unknown receipts retain their uncertainty.
-- Updating approvals also refreshes the conversation's cached Feed attention.
UPDATE approvals SET state='rejected',result='{"reason":"Run ended before this request was approved."}'
WHERE state='pending' AND EXISTS (
  SELECT 1 FROM runs r WHERE r.id=approvals.run_id AND r.owner_id=approvals.owner_id
    AND r.state IN ('completed','cancelled','failed','interrupted')
);

CREATE TRIGGER close_terminal_run_approvals AFTER UPDATE OF state ON runs
WHEN NEW.state IN ('completed','cancelled','failed','interrupted') BEGIN
  UPDATE approvals SET state='rejected',result='{"reason":"Run ended before this request was approved."}'
  WHERE run_id=NEW.id AND owner_id=NEW.owner_id AND state='pending';
END;

INSERT INTO schema_version VALUES(103,unixepoch()*1000);
