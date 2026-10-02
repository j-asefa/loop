-- Traces stay out of workspace search so Feed and Search remain
-- conversation-first. This separate index backs the Traces tab filter.
CREATE VIRTUAL TABLE trace_fts USING fts5(title, content, content='run_traces', content_rowid='id', tokenize='unicode61');
CREATE TRIGGER trace_search_insert AFTER INSERT ON run_traces BEGIN
  INSERT INTO trace_fts(rowid,title,content) VALUES(new.id,new.title,new.content);
END;
CREATE TRIGGER trace_search_update AFTER UPDATE OF title,content ON run_traces BEGIN
  INSERT INTO trace_fts(trace_fts,rowid,title,content) VALUES('delete',old.id,old.title,old.content);
  INSERT INTO trace_fts(rowid,title,content) VALUES(new.id,new.title,new.content);
END;
CREATE TRIGGER trace_search_delete AFTER DELETE ON run_traces BEGIN
  INSERT INTO trace_fts(trace_fts,rowid,title,content) VALUES('delete',old.id,old.title,old.content);
END;
INSERT INTO trace_fts(trace_fts) VALUES('rebuild');
INSERT INTO schema_version VALUES(40,unixepoch()*1000);
