-- Codex can wrap mid-turn commentary in Loop's structured reply envelope
-- ({"kind":"answer","text":...}). Those updates were saved verbatim and shown
-- as raw JSON. Keep only the answer text; a tool request has none, and empty
-- updates are already hidden.
UPDATE run_traces SET content=json_extract(content,'$.text')
WHERE kind='message' AND json_valid(content)
  AND json_extract(content,'$.kind')='answer'
  AND json_type(content,'$.text')='text';
UPDATE run_traces SET content=''
WHERE kind='message' AND json_valid(content)
  AND json_extract(content,'$.kind')='tool'
  AND json_type(content,'$.text')='text';
INSERT INTO schema_version VALUES(46,unixepoch()*1000);
