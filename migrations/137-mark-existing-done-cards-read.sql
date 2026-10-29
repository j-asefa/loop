-- Mark the existing Done results read once, including dismissed cards and
-- saved-group members. Keep any original read timestamp. Older upgrades seed
-- unprojected history in done-card-reads before reaching this migration.
-- The insert trigger queues each result for the startup Feed projector, so
-- card markers, group read state and the unread badge agree before serving.
INSERT OR IGNORE INTO done_card_reads(owner_id,conversation_id,card_key,read_at)
SELECT p.owner_id,p.conversation_id,p.card_key,unixepoch('subsec')*1000
FROM feed_cards p
JOIN conversations c ON c.id=p.conversation_id AND c.owner_id=p.owner_id
WHERE p.kind='result';
