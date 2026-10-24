-- Turn completion and session recovery must not scan historical requests.
-- The state column follows request TEXT, so even filtering an unmatched row
-- can read its overflow pages without these indexes.
CREATE INDEX native_decisions_run_state ON native_decisions(run_id,state);
CREATE INDEX native_decisions_state_generation ON native_decisions(state,conversation_id,generation,native_id);
INSERT INTO schema_version VALUES(113,unixepoch()*1000);
