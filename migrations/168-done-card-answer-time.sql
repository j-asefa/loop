-- Done cards now report when a sealed answer was published (the Result's
-- created_at) instead of when its message row was created, which native
-- harnesses do at the start of the turn. Re-project existing result cards so
-- their stored payloads carry the published time. Source rows are unchanged.
INSERT OR IGNORE INTO feed_card_dirty(owner_id, conversation_id, card_key)
SELECT owner_id, conversation_id, id FROM results
WHERE sealed = 1 AND kind IN ('run_answer', 'imported_answer');
