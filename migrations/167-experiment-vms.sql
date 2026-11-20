-- Cloud VM Experiments. One Experiment is one provider VM linked 1:1 to a
-- project folder. Conversations, results and published files stay in this
-- database and its object store, so no row here is needed to read history.
-- Additive: releases before this migration wrote none of these tables.

-- The owner's provider account. The key is sealed with the owner-bound
-- secret store and never leaves this host.
CREATE TABLE vm_provider_configs (
  owner_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  encrypted_api_key TEXT NOT NULL,
  app_id TEXT,
  auth_volume_id TEXT,
  base_image_ref TEXT,
  base_image_version TEXT,
  default_harness TEXT,
  updated_at INTEGER NOT NULL
);

-- remote_name is chosen before the provider is called, so an uncertain create
-- can be reconciled by looking the name up instead of creating a second VM.
CREATE TABLE experiment_vms (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  folder_id TEXT NOT NULL UNIQUE REFERENCES folders(id),
  provider TEXT NOT NULL,
  remote_id TEXT,
  remote_name TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  auto_approve_local INTEGER NOT NULL DEFAULT 1,
  vcpu_limit INTEGER NOT NULL DEFAULT 4,
  memory_limit_gib INTEGER NOT NULL DEFAULT 16,
  disk_limit_gib INTEGER NOT NULL DEFAULT 64,
  auto_sleep_seconds INTEGER NOT NULL DEFAULT 900,
  source_experiment_id TEXT REFERENCES experiment_vms(id),
  source_checkpoint_id TEXT,
  clone_url TEXT,
  last_error TEXT,
  last_active_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  destroyed_at INTEGER
);
CREATE INDEX experiment_vms_owner ON experiment_vms(owner_id, created_at);

CREATE TABLE experiment_previews (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL REFERENCES experiment_vms(id),
  port INTEGER NOT NULL,
  label TEXT,
  path TEXT NOT NULL DEFAULT '/',
  url TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(experiment_id, port)
);

-- A receipt written before every provider call. id is the caller's
-- idempotency key, unique within the owner; request_digest refuses the same key for a different
-- request, and request_json keeps the request so a reconcile can check what
-- was asked. An operation left pending by a crash becomes uncertain and is
-- never sent again without the owner asking.
CREATE TABLE vm_operations (
  id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL REFERENCES experiment_vms(id),
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  request_json TEXT NOT NULL,
  result_json TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, id)
);
CREATE INDEX vm_operations_experiment ON vm_operations(experiment_id, created_at);
CREATE INDEX vm_operations_unsettled ON vm_operations(state) WHERE state IN ('pending', 'uncertain');
