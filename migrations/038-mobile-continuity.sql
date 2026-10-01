-- Short labels on saved items, so a saved decision can be recognised and
-- found again ("Chosen approach"). Keyed like the Saved list: 'm:<message>'
-- for a saved message, 'a:<artifact>' for a saved result. Labels belong to
-- one owner; a label is kept if its item is unsaved and saved again.
CREATE TABLE saved_labels(owner_id TEXT NOT NULL, item_key TEXT NOT NULL, label TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(owner_id,item_key));

-- How many times a reminder was snoozed again in place, so its row can say so.
ALTER TABLE later_items ADD COLUMN snoozes INTEGER NOT NULL DEFAULT 0;
INSERT INTO schema_version VALUES(38,unixepoch()*1000);
