CREATE TABLE IF NOT EXISTS results (
  id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL CHECK(kind IN ('run_answer', 'steering_reply', 'imported_answer')),
  origin_completeness TEXT NOT NULL CHECK(origin_completeness IN ('sealed_at_publication', 'migrated_backfill')),
  sealed INTEGER NOT NULL DEFAULT 1 CHECK(sealed IN (0, 1)),
  created_at INTEGER NOT NULL,
  conversation_id TEXT NOT NULL,
  run_id TEXT,
  message_id TEXT NOT NULL,
  agent_id TEXT,
  content_digest TEXT NOT NULL,
  stimulus TEXT NOT NULL,
  outcome TEXT NOT NULL,
  attachments TEXT NOT NULL,
  provenance TEXT NOT NULL,
  lineage TEXT NOT NULL,
  PRIMARY KEY (owner_id, id)
);

CREATE INDEX IF NOT EXISTS results_conversation ON results(owner_id, conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS results_run ON results(owner_id, run_id) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS results_message ON results(owner_id, message_id);

CREATE TABLE IF NOT EXISTS result_context_edges (
  owner_id TEXT NOT NULL,
  result_id TEXT NOT NULL,
  source_result_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  excerpt INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, result_id, source_result_id, position)
);

CREATE INDEX IF NOT EXISTS result_context_edges_source
  ON result_context_edges(owner_id, source_result_id, created_at DESC);

-- 1. Backfill completed run answers (run:<runId>)
WITH run_candidates AS (
  SELECT
    'run:' || r.id AS id,
    r.owner_id AS owner_id,
    'run_answer' AS kind,
    1 AS sealed,
    COALESCE(r.updated_at, m.created_at, r.created_at) AS created_at,
    r.conversation_id AS conversation_id,
    r.id AS run_id,
    m.id AS message_id,
    COALESCE(r.agent_id, c.agent_id) AS agent_id,
    json_object(
      'kind', CASE
        WHEN json_valid(t.metadata) AND json_extract(t.metadata, '$.automation.kind') IN ('agent_message', 'agent_result', 'agent_ping') THEN 'delegation'
        WHEN json_valid(t.metadata) AND json_extract(t.metadata, '$.automation.kind') IN ('feed_digest', 'schedule') THEN 'schedule'
        WHEN json_valid(t.metadata) AND json_extract(t.metadata, '$.automation.kind') IS NOT NULL THEN 'system'
        ELSE 'user_prompt'
      END,
      'text', r.input,
      'sourceMessageId', t.id,
      'authorKind', CASE
        WHEN json_valid(t.metadata) AND json_extract(t.metadata, '$.automation.kind') IN ('agent_message', 'agent_result', 'agent_ping') THEN 'agent'
        WHEN json_valid(t.metadata) AND json_extract(t.metadata, '$.automation.kind') IS NOT NULL THEN 'system'
        ELSE 'owner'
      END,
      'automationKind', CASE WHEN json_valid(t.metadata) AND json_type(t.metadata, '$.automation.kind') = 'text' THEN json_extract(t.metadata, '$.automation.kind') END,
      'automationFrom', CASE WHEN json_valid(t.metadata) AND json_type(t.metadata, '$.automation.fromName') = 'text' THEN json_extract(t.metadata, '$.automation.fromName') END
    ) AS stimulus,
    json_object(
      'title', substr(
        COALESCE(
          NULLIF(trim(replace(replace(replace(r.input, char(13), ' '), char(10), ' '), char(9), ' ')), ''),
          NULLIF(trim(replace(replace(replace(m.content, char(13), ' '), char(10), ' '), char(9), ' ')), ''),
          NULLIF(trim(c.title), ''),
          'Result'
        ),
        1,
        200
      ),
      'body', m.content,
      'format', 'markdown'
    ) AS outcome,
    COALESCE((
      SELECT json_group_array(json(att_obj))
      FROM (
        SELECT json_object(
          'artifactId', a.id,
          'objectId', (
            SELECT o.id FROM objects o
            WHERE o.owner_id = a.owner_id
              AND o.id = CASE
                WHEN json_valid(a.metadata) AND json_type(a.metadata, '$.objectId') = 'text'
                THEN json_extract(a.metadata, '$.objectId')
              END
          ),
          'version', CASE WHEN a.version IS NOT NULL AND a.version >= 1 THEN a.version ELSE 1 END,
          'sha256', (SELECT ao.checksum FROM artifact_objects ao WHERE ao.artifact_id = a.id AND ao.owner_id = a.owner_id LIMIT 1),
          'name', COALESCE(
            NULLIF(trim(CASE WHEN json_type(je.value, '$.name') = 'text' THEN json_extract(je.value, '$.name') END), ''),
            NULLIF(trim(a.title), ''),
            a.id
          ),
          'mime', COALESCE(
            NULLIF(trim(CASE WHEN json_type(je.value, '$.mime') = 'text' THEN json_extract(je.value, '$.mime') END), ''),
            NULLIF(trim(CASE WHEN json_valid(a.metadata) AND json_type(a.metadata, '$.mime') = 'text' THEN json_extract(a.metadata, '$.mime') END), ''),
            NULLIF(trim((SELECT ao.mime FROM artifact_objects ao WHERE ao.artifact_id = a.id AND ao.owner_id = a.owner_id LIMIT 1)), ''),
            'application/octet-stream'
          ),
          'size', MAX(0, CAST(COALESCE(
            CASE WHEN json_type(je.value, '$.size') IN ('integer', 'real') THEN json_extract(je.value, '$.size') END,
            CASE WHEN json_valid(a.metadata) AND json_type(a.metadata, '$.size') IN ('integer', 'real') THEN json_extract(a.metadata, '$.size') END,
            (SELECT ao.size FROM artifact_objects ao WHERE ao.artifact_id = a.id AND ao.owner_id = a.owner_id LIMIT 1),
            0
          ) AS INTEGER)),
          'published', json(CASE WHEN EXISTS(SELECT 1 FROM artifact_objects ao WHERE ao.artifact_id = a.id AND ao.owner_id = a.owner_id) THEN 'true' ELSE 'false' END)
        ) AS att_obj
        FROM json_each(CASE
          WHEN json_valid(m.metadata) AND json_type(m.metadata, '$.attachments') = 'array'
          THEN json_extract(m.metadata, '$.attachments')
          ELSE '[]'
        END) je
        JOIN artifacts a
          ON json_type(je.value) = 'object'
          AND json_type(je.value, '$.id') = 'text'
          AND a.id = json_extract(je.value, '$.id')
          AND a.owner_id = r.owner_id
        ORDER BY je.key ASC
      )
    ), '[]') AS attachments,
    json_object(
      'agentId', COALESCE(r.agent_id, c.agent_id),
      'agentName', COALESCE(
        NULLIF(trim(g.name), ''),
        CASE WHEN json_valid(r.payload) AND json_type(r.payload, '$.name') = 'text' THEN NULLIF(trim(json_extract(r.payload, '$.name')), '') END
      ),
      'provider', COALESCE(
        CASE WHEN json_valid(r.payload) AND json_type(r.payload, '$.provider') = 'text' THEN NULLIF(trim(json_extract(r.payload, '$.provider')), '') END,
        g.provider
      ),
      'model', COALESCE(
        CASE WHEN json_valid(r.payload) AND json_type(r.payload, '$.model') = 'text' THEN NULLIF(trim(json_extract(r.payload, '$.model')), '') END,
        g.model
      ),
      'resolvedModel', COALESCE(
        CASE WHEN json_valid(r.payload) AND json_type(r.payload, '$.resolvedModel') = 'text' THEN NULLIF(trim(json_extract(r.payload, '$.resolvedModel')), '') END,
        CASE WHEN json_valid(r.result) AND json_type(r.result, '$.resolvedModel') = 'text' THEN NULLIF(trim(json_extract(r.result, '$.resolvedModel')), '') END
      ),
      'connectionId', COALESCE(
        CASE WHEN json_valid(r.payload) AND json_type(r.payload, '$.connectionId') = 'text' THEN NULLIF(trim(json_extract(r.payload, '$.connectionId')), '') END,
        c.execution_connection_id,
        g.connection_id
      ),
      'conversationId', r.conversation_id,
      'runId', r.id,
      'messageId', m.id,
      'placement', json_object('status', 'unknown', 'folderId', NULL, 'projectId', NULL, 'projectName', NULL, 'teamId', NULL)
    ) AS provenance,
    json_object(
      'parentResultId', NULL,
      'triggerMessageId', t.id,
      'suppliedContext', json('[]')
    ) AS lineage
  FROM runs r
  JOIN conversations c ON c.id = r.conversation_id AND c.owner_id = r.owner_id
  JOIN messages m ON m.id = (
    SELECT m2.id FROM messages m2
    WHERE m2.owner_id = r.owner_id
      AND m2.conversation_id = r.conversation_id
      AND m2.run_id = r.id
      AND m2.role = 'assistant'
      AND (NOT json_valid(m2.metadata) OR COALESCE(json_extract(m2.metadata, '$.progress'), 0) = 0)
      AND (NOT json_valid(m2.metadata) OR COALESCE(json_extract(m2.metadata, '$.partial'), 0) != 1)
      AND length(trim(m2.content, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))) > 0
    ORDER BY m2.created_at DESC, m2.rowid DESC
    LIMIT 1
  ) AND m.owner_id = r.owner_id
  LEFT JOIN messages t ON t.id = (
    SELECT u2.id FROM messages u2
    WHERE u2.owner_id = r.owner_id
      AND u2.conversation_id = r.conversation_id
      AND u2.run_id = r.id
      AND u2.role = 'user'
      AND (NOT json_valid(u2.metadata) OR json_extract(u2.metadata, '$.steeringId') IS NULL)
    ORDER BY u2.created_at DESC, u2.rowid DESC
    LIMIT 1
  ) AND t.owner_id = r.owner_id
  LEFT JOIN agents g ON g.id = COALESCE(r.agent_id, c.agent_id) AND g.owner_id = r.owner_id
  WHERE r.state = 'completed' AND r.conversation_id IS NOT NULL
)
INSERT OR IGNORE INTO results (
  id, owner_id, schema_version, kind, origin_completeness, sealed,
  created_at, conversation_id, run_id, message_id, agent_id,
  content_digest, stimulus, outcome, attachments, provenance, lineage
)
SELECT
  id, owner_id, 1, kind, 'migrated_backfill', sealed,
  created_at, conversation_id, run_id, message_id, agent_id,
  '0000000000000000000000000000000000000000000000000000000000000000',
  stimulus, outcome, attachments, provenance, lineage
FROM run_candidates;

-- 2. Backfill published steering replies (reply:<messageId>)
WITH reply_candidates AS (
  SELECT
    'reply:' || p.message_id AS id,
    p.owner_id AS owner_id,
    'steering_reply' AS kind,
    1 AS sealed,
    p.created_at AS created_at,
    m.conversation_id AS conversation_id,
    COALESCE(s.run_id, m.run_id) AS run_id,
    p.message_id AS message_id,
    COALESCE(r.agent_id, c.agent_id) AS agent_id,
    json_object(
      'kind', 'steering_question',
      'text', q.content,
      'sourceMessageId', q.id,
      'authorKind', 'owner',
      'automationKind', NULL,
      'automationFrom', NULL
    ) AS stimulus,
    json_object(
      'title', substr(
        COALESCE(
          NULLIF(trim(replace(replace(replace(q.content, char(13), ' '), char(10), ' '), char(9), ' ')), ''),
          NULLIF(trim(replace(replace(replace(m.content, char(13), ' '), char(10), ' '), char(9), ' ')), ''),
          NULLIF(trim(c.title), ''),
          'Reply'
        ),
        1,
        200
      ),
      'body', m.content,
      'format', 'markdown'
    ) AS outcome,
    COALESCE((
      SELECT json_group_array(json(att_obj))
      FROM (
        SELECT json_object(
          'artifactId', a.id,
          'objectId', (
            SELECT o.id FROM objects o
            WHERE o.owner_id = a.owner_id
              AND o.id = CASE
                WHEN json_valid(a.metadata) AND json_type(a.metadata, '$.objectId') = 'text'
                THEN json_extract(a.metadata, '$.objectId')
              END
          ),
          'version', CASE WHEN a.version IS NOT NULL AND a.version >= 1 THEN a.version ELSE 1 END,
          'sha256', (SELECT ao.checksum FROM artifact_objects ao WHERE ao.artifact_id = a.id AND ao.owner_id = a.owner_id LIMIT 1),
          'name', COALESCE(
            NULLIF(trim(CASE WHEN json_type(je.value, '$.name') = 'text' THEN json_extract(je.value, '$.name') END), ''),
            NULLIF(trim(a.title), ''),
            a.id
          ),
          'mime', COALESCE(
            NULLIF(trim(CASE WHEN json_type(je.value, '$.mime') = 'text' THEN json_extract(je.value, '$.mime') END), ''),
            NULLIF(trim(CASE WHEN json_valid(a.metadata) AND json_type(a.metadata, '$.mime') = 'text' THEN json_extract(a.metadata, '$.mime') END), ''),
            NULLIF(trim((SELECT ao.mime FROM artifact_objects ao WHERE ao.artifact_id = a.id AND ao.owner_id = a.owner_id LIMIT 1)), ''),
            'application/octet-stream'
          ),
          'size', MAX(0, CAST(COALESCE(
            CASE WHEN json_type(je.value, '$.size') IN ('integer', 'real') THEN json_extract(je.value, '$.size') END,
            CASE WHEN json_valid(a.metadata) AND json_type(a.metadata, '$.size') IN ('integer', 'real') THEN json_extract(a.metadata, '$.size') END,
            (SELECT ao.size FROM artifact_objects ao WHERE ao.artifact_id = a.id AND ao.owner_id = a.owner_id LIMIT 1),
            0
          ) AS INTEGER)),
          'published', json(CASE WHEN EXISTS(SELECT 1 FROM artifact_objects ao WHERE ao.artifact_id = a.id AND ao.owner_id = a.owner_id) THEN 'true' ELSE 'false' END)
        ) AS att_obj
        FROM json_each(CASE
          WHEN json_valid(m.metadata) AND json_type(m.metadata, '$.attachments') = 'array'
          THEN json_extract(m.metadata, '$.attachments')
          ELSE '[]'
        END) je
        JOIN artifacts a
          ON json_type(je.value) = 'object'
          AND json_type(je.value, '$.id') = 'text'
          AND a.id = json_extract(je.value, '$.id')
          AND a.owner_id = p.owner_id
        ORDER BY je.key ASC
      )
    ), '[]') AS attachments,
    json_object(
      'agentId', COALESCE(r.agent_id, c.agent_id),
      'agentName', COALESCE(
        NULLIF(trim(g.name), ''),
        CASE WHEN json_valid(r.payload) AND json_type(r.payload, '$.name') = 'text' THEN NULLIF(trim(json_extract(r.payload, '$.name')), '') END
      ),
      'provider', COALESCE(
        CASE WHEN json_valid(r.payload) AND json_type(r.payload, '$.provider') = 'text' THEN NULLIF(trim(json_extract(r.payload, '$.provider')), '') END,
        g.provider
      ),
      'model', COALESCE(
        CASE WHEN json_valid(r.payload) AND json_type(r.payload, '$.model') = 'text' THEN NULLIF(trim(json_extract(r.payload, '$.model')), '') END,
        g.model
      ),
      'resolvedModel', COALESCE(
        CASE WHEN json_valid(r.payload) AND json_type(r.payload, '$.resolvedModel') = 'text' THEN NULLIF(trim(json_extract(r.payload, '$.resolvedModel')), '') END,
        CASE WHEN json_valid(r.result) AND json_type(r.result, '$.resolvedModel') = 'text' THEN NULLIF(trim(json_extract(r.result, '$.resolvedModel')), '') END
      ),
      'connectionId', COALESCE(
        CASE WHEN json_valid(r.payload) AND json_type(r.payload, '$.connectionId') = 'text' THEN NULLIF(trim(json_extract(r.payload, '$.connectionId')), '') END,
        c.execution_connection_id,
        g.connection_id
      ),
      'conversationId', m.conversation_id,
      'runId', COALESCE(s.run_id, m.run_id),
      'messageId', m.id,
      'placement', json_object('status', 'unknown', 'folderId', NULL, 'projectId', NULL, 'projectName', NULL, 'teamId', NULL)
    ) AS provenance,
    json_object(
      'parentResultId', NULL,
      'triggerMessageId', q.id,
      'suppliedContext', json('[]')
    ) AS lineage
  FROM steering_replies p
  JOIN messages m ON m.id = p.message_id AND m.owner_id = p.owner_id
  LEFT JOIN run_steering s ON s.id = p.steering_id AND s.owner_id = p.owner_id
  LEFT JOIN messages q ON q.id = s.message_id AND q.owner_id = p.owner_id
  LEFT JOIN runs r ON r.id = COALESCE(s.run_id, m.run_id) AND r.owner_id = p.owner_id
  JOIN conversations c ON c.id = m.conversation_id AND c.owner_id = p.owner_id
  LEFT JOIN agents g ON g.id = COALESCE(r.agent_id, c.agent_id) AND g.owner_id = p.owner_id
  WHERE m.role = 'assistant'
)
INSERT OR IGNORE INTO results (
  id, owner_id, schema_version, kind, origin_completeness, sealed,
  created_at, conversation_id, run_id, message_id, agent_id,
  content_digest, stimulus, outcome, attachments, provenance, lineage
)
SELECT
  id, owner_id, 1, kind, 'migrated_backfill', sealed,
  created_at, conversation_id, run_id, message_id, agent_id,
  '0000000000000000000000000000000000000000000000000000000000000000',
  stimulus, outcome, attachments, provenance, lineage
FROM reply_candidates;

-- 3. Backfill standalone / imported assistant answers (message:<messageId>)
-- Fork and continuation copies keep the author of their source answer. A copy
-- names its source in `sourceMessage`; the chain is followed to the first
-- source with a sealed Result or to the original message.
WITH RECURSIVE copy_chain(message_id, owner_id, source_id, depth) AS (
  SELECT m.id, m.owner_id, json_extract(m.metadata, '$.sourceMessage'), 1
  FROM messages m
  WHERE m.run_id IS NULL
    AND m.role = 'assistant'
    AND json_valid(m.metadata)
    AND json_type(m.metadata, '$.sourceMessage') = 'text'
  UNION ALL
  SELECT cc.message_id, cc.owner_id, json_extract(s.metadata, '$.sourceMessage'), cc.depth + 1
  FROM copy_chain cc
  JOIN messages s ON s.id = cc.source_id AND s.owner_id = cc.owner_id
  WHERE cc.depth < 32
    AND json_valid(s.metadata)
    AND json_type(s.metadata, '$.sourceMessage') = 'text'
    AND NOT EXISTS (
      SELECT 1 FROM results sr
      WHERE sr.owner_id = s.owner_id AND sr.message_id = s.id AND sr.sealed = 1
    )
),
copy_root AS (
  SELECT cc.message_id, cc.owner_id, cc.source_id
  FROM copy_chain cc
  WHERE cc.depth = (
    SELECT MAX(c2.depth) FROM copy_chain c2
    WHERE c2.message_id = cc.message_id AND c2.owner_id = cc.owner_id
  )
),
copy_author AS (
  SELECT
    cr.message_id,
    cr.owner_id,
    CASE
      WHEN sres.id IS NOT NULL THEN json_extract(sres.provenance, '$.agentId')
      WHEN sm.id IS NOT NULL THEN COALESCE(srun.agent_id, sc.agent_id)
    END AS agent_id,
    CASE
      WHEN sres.id IS NOT NULL THEN json_extract(sres.provenance, '$.agentName')
      WHEN sm.id IS NOT NULL THEN COALESCE(
        NULLIF(trim(sg.name), ''),
        CASE WHEN json_valid(srun.payload) AND json_type(srun.payload, '$.name') = 'text' THEN NULLIF(trim(json_extract(srun.payload, '$.name')), '') END
      )
    END AS agent_name,
    CASE
      WHEN sres.id IS NOT NULL THEN json_extract(sres.provenance, '$.provider')
      WHEN sm.id IS NOT NULL THEN COALESCE(
        CASE WHEN json_valid(srun.payload) AND json_type(srun.payload, '$.provider') = 'text' THEN NULLIF(trim(json_extract(srun.payload, '$.provider')), '') END,
        sg.provider
      )
    END AS provider,
    CASE
      WHEN sres.id IS NOT NULL THEN json_extract(sres.provenance, '$.model')
      WHEN sm.id IS NOT NULL THEN COALESCE(
        CASE WHEN json_valid(srun.payload) AND json_type(srun.payload, '$.model') = 'text' THEN NULLIF(trim(json_extract(srun.payload, '$.model')), '') END,
        sg.model
      )
    END AS model,
    CASE
      WHEN sres.id IS NOT NULL THEN json_extract(sres.provenance, '$.resolvedModel')
      WHEN sm.id IS NOT NULL THEN COALESCE(
        CASE WHEN json_valid(srun.payload) AND json_type(srun.payload, '$.resolvedModel') = 'text' THEN NULLIF(trim(json_extract(srun.payload, '$.resolvedModel')), '') END,
        CASE WHEN json_valid(srun.result) AND json_type(srun.result, '$.resolvedModel') = 'text' THEN NULLIF(trim(json_extract(srun.result, '$.resolvedModel')), '') END
      )
    END AS resolved_model,
    CASE
      WHEN sres.id IS NOT NULL THEN json_extract(sres.provenance, '$.connectionId')
      WHEN sm.id IS NOT NULL THEN COALESCE(
        CASE WHEN json_valid(srun.payload) AND json_type(srun.payload, '$.connectionId') = 'text' THEN NULLIF(trim(json_extract(srun.payload, '$.connectionId')), '') END,
        sc.execution_connection_id,
        sg.connection_id
      )
    END AS connection_id
  FROM copy_root cr
  LEFT JOIN results sres ON sres.owner_id = cr.owner_id AND sres.id = (
    SELECT r2.id FROM results r2
    WHERE r2.owner_id = cr.owner_id AND r2.message_id = cr.source_id AND r2.sealed = 1
    ORDER BY r2.created_at ASC, r2.rowid ASC
    LIMIT 1
  )
  LEFT JOIN messages sm ON sm.id = cr.source_id AND sm.owner_id = cr.owner_id
  LEFT JOIN conversations sc ON sc.id = sm.conversation_id AND sc.owner_id = sm.owner_id
  LEFT JOIN runs srun ON srun.id = sm.run_id AND srun.owner_id = sm.owner_id
  LEFT JOIN agents sg ON sg.id = COALESCE(srun.agent_id, sc.agent_id) AND sg.owner_id = cr.owner_id
),
message_candidates AS (
  SELECT
    'message:' || m.id AS id,
    m.owner_id AS owner_id,
    'imported_answer' AS kind,
    1 AS sealed,
    m.created_at AS created_at,
    m.conversation_id AS conversation_id,
    NULL AS run_id,
    m.id AS message_id,
    CASE WHEN ca.message_id IS NULL THEN c.agent_id ELSE ca.agent_id END AS agent_id,
    json_object(
      'kind', CASE WHEN c.origin IN ('import', 'openai-import', 'anthropic-import') THEN 'import' ELSE 'user_prompt' END,
      'text', u.content,
      'sourceMessageId', u.id,
      'authorKind', 'owner',
      'automationKind', NULL,
      'automationFrom', NULL
    ) AS stimulus,
    json_object(
      'title', substr(
        COALESCE(
          NULLIF(trim(replace(replace(replace(u.content, char(13), ' '), char(10), ' '), char(9), ' ')), ''),
          NULLIF(trim(replace(replace(replace(m.content, char(13), ' '), char(10), ' '), char(9), ' ')), ''),
          NULLIF(trim(c.title), ''),
          'Result'
        ),
        1,
        200
      ),
      'body', m.content,
      'format', 'markdown'
    ) AS outcome,
    COALESCE((
      SELECT json_group_array(json(att_obj))
      FROM (
        SELECT json_object(
          'artifactId', a.id,
          'objectId', (
            SELECT o.id FROM objects o
            WHERE o.owner_id = a.owner_id
              AND o.id = CASE
                WHEN json_valid(a.metadata) AND json_type(a.metadata, '$.objectId') = 'text'
                THEN json_extract(a.metadata, '$.objectId')
              END
          ),
          'version', CASE WHEN a.version IS NOT NULL AND a.version >= 1 THEN a.version ELSE 1 END,
          'sha256', (SELECT ao.checksum FROM artifact_objects ao WHERE ao.artifact_id = a.id AND ao.owner_id = a.owner_id LIMIT 1),
          'name', COALESCE(
            NULLIF(trim(CASE WHEN json_type(je.value, '$.name') = 'text' THEN json_extract(je.value, '$.name') END), ''),
            NULLIF(trim(a.title), ''),
            a.id
          ),
          'mime', COALESCE(
            NULLIF(trim(CASE WHEN json_type(je.value, '$.mime') = 'text' THEN json_extract(je.value, '$.mime') END), ''),
            NULLIF(trim(CASE WHEN json_valid(a.metadata) AND json_type(a.metadata, '$.mime') = 'text' THEN json_extract(a.metadata, '$.mime') END), ''),
            NULLIF(trim((SELECT ao.mime FROM artifact_objects ao WHERE ao.artifact_id = a.id AND ao.owner_id = a.owner_id LIMIT 1)), ''),
            'application/octet-stream'
          ),
          'size', MAX(0, CAST(COALESCE(
            CASE WHEN json_type(je.value, '$.size') IN ('integer', 'real') THEN json_extract(je.value, '$.size') END,
            CASE WHEN json_valid(a.metadata) AND json_type(a.metadata, '$.size') IN ('integer', 'real') THEN json_extract(a.metadata, '$.size') END,
            (SELECT ao.size FROM artifact_objects ao WHERE ao.artifact_id = a.id AND ao.owner_id = a.owner_id LIMIT 1),
            0
          ) AS INTEGER)),
          'published', json(CASE WHEN EXISTS(SELECT 1 FROM artifact_objects ao WHERE ao.artifact_id = a.id AND ao.owner_id = a.owner_id) THEN 'true' ELSE 'false' END)
        ) AS att_obj
        FROM json_each(CASE
          WHEN json_valid(m.metadata) AND json_type(m.metadata, '$.attachments') = 'array'
          THEN json_extract(m.metadata, '$.attachments')
          ELSE '[]'
        END) je
        JOIN artifacts a
          ON json_type(je.value) = 'object'
          AND json_type(je.value, '$.id') = 'text'
          AND a.id = json_extract(je.value, '$.id')
          AND a.owner_id = m.owner_id
        ORDER BY je.key ASC
      )
    ), '[]') AS attachments,
    json_object(
      'agentId', CASE WHEN ca.message_id IS NULL THEN c.agent_id ELSE ca.agent_id END,
      'agentName', CASE WHEN ca.message_id IS NULL THEN NULLIF(trim(g.name), '') ELSE ca.agent_name END,
      'provider', CASE WHEN ca.message_id IS NULL THEN g.provider ELSE ca.provider END,
      'model', CASE WHEN ca.message_id IS NULL THEN g.model ELSE ca.model END,
      'resolvedModel', CASE WHEN ca.message_id IS NULL THEN NULL ELSE ca.resolved_model END,
      'connectionId', CASE WHEN ca.message_id IS NULL THEN COALESCE(c.execution_connection_id, g.connection_id) ELSE ca.connection_id END,
      'conversationId', m.conversation_id,
      'runId', NULL,
      'messageId', m.id,
      'placement', json_object('status', 'unknown', 'folderId', NULL, 'projectId', NULL, 'projectName', NULL, 'teamId', NULL)
    ) AS provenance,
    json_object(
      'parentResultId', NULL,
      'triggerMessageId', u.id,
      'suppliedContext', json('[]')
    ) AS lineage
  FROM messages m
  JOIN conversations c ON c.id = m.conversation_id AND c.owner_id = m.owner_id
  LEFT JOIN messages u ON u.id = (
    SELECT u2.id FROM messages u2
    WHERE u2.owner_id = m.owner_id
      AND u2.conversation_id = m.conversation_id
      AND u2.run_id IS NULL
      AND u2.role = 'user'
      AND (u2.created_at < m.created_at OR (u2.created_at = m.created_at AND u2.rowid < m.rowid))
    ORDER BY u2.created_at DESC, u2.rowid DESC
    LIMIT 1
  ) AND u.owner_id = m.owner_id
  LEFT JOIN agents g ON g.id = c.agent_id AND g.owner_id = m.owner_id
  LEFT JOIN copy_author ca ON ca.message_id = m.id AND ca.owner_id = m.owner_id
  WHERE m.run_id IS NULL
    AND m.role = 'assistant'
    AND (NOT json_valid(m.metadata) OR COALESCE(json_extract(m.metadata, '$.progress'), 0) = 0)
    AND (NOT json_valid(m.metadata) OR COALESCE(json_extract(m.metadata, '$.partial'), 0) != 1)
    AND length(trim(m.content, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))) > 0
)
INSERT OR IGNORE INTO results (
  id, owner_id, schema_version, kind, origin_completeness, sealed,
  created_at, conversation_id, run_id, message_id, agent_id,
  content_digest, stimulus, outcome, attachments, provenance, lineage
)
SELECT
  id, owner_id, 1, kind, 'migrated_backfill', sealed,
  created_at, conversation_id, run_id, message_id, agent_id,
  '0000000000000000000000000000000000000000000000000000000000000000',
  stimulus, outcome, attachments, provenance, lineage
FROM message_candidates;

-- 4. Chain backfilled results chronologically across kinds within a conversation.
WITH ordered AS (
  SELECT owner_id, id,
    LAG(id) OVER (PARTITION BY owner_id, conversation_id ORDER BY created_at ASC, rowid ASC) AS previous_id
  FROM results
  WHERE sealed = 1
)
UPDATE results
SET lineage = json_set(lineage, '$.parentResultId', (
  SELECT o.previous_id FROM ordered o WHERE o.owner_id = results.owner_id AND o.id = results.id
))
WHERE origin_completeness = 'migrated_backfill' AND sealed = 1;

INSERT OR IGNORE INTO feed_card_dirty(owner_id, conversation_id, card_key)
SELECT owner_id, conversation_id, id FROM results
WHERE kind IN ('run_answer', 'imported_answer');
