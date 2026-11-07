-- A crash during a tool call can leave its approval and tool invocation
-- 'executing'. Once the run reaches a terminal state that call can never be
-- confirmed, so its outcome is 'unknown' and is never replayed. This mirrors
-- close_terminal_run_approvals (migration 103), which rejects 'pending'
-- requests; 'executing' keeps its uncertainty. The broker's own
-- unknownExecuting overwrites this placeholder with the precise failure when
-- it is the writer (it now accepts state IN ('executing','unknown')).

CREATE TRIGGER unknown_terminal_tool_calls AFTER UPDATE OF state ON runs
WHEN NEW.state IN ('completed','failed','cancelled','interrupted') BEGIN
  UPDATE approvals SET state='unknown',result='{"error":"Uncertain external outcome. The run ended before a result; nothing was replayed.","failure":{"outcome":"unknown"}}'
  WHERE run_id=NEW.id AND owner_id=NEW.owner_id AND state='executing';
  UPDATE tool_invocations SET state='unknown',result='{"isError":true,"content":[{"type":"text","text":"Uncertain external outcome. The run ended before a result; nothing was replayed."}],"failure":{"outcome":"unknown"}}'
  WHERE run_id=NEW.id AND owner_id=NEW.owner_id AND state='executing';
END;