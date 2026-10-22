-- Evaluate final-answer eligibility once when a message changes. Expanded
-- Done can enumerate result identities without rereading historical bodies.
-- Keep this predicate aligned with nonemptyAnswer in mobile-return.ts.
CREATE INDEX messages_feed_answers
ON messages(owner_id,run_id,conversation_id,created_at DESC,id)
WHERE role='assistant' AND COALESCE(json_extract(metadata,'$.progress'),0)=0
  AND length(trim(content,char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)))>0;
INSERT INTO schema_version VALUES(102,unixepoch()*1000);
