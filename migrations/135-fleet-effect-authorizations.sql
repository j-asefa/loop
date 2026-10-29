CREATE TABLE fleet_effect_authorizations (
  owner_id TEXT NOT NULL,
  effect_kind TEXT NOT NULL CHECK(effect_kind IN ('run','steering','scheduled')),
  effect_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  grant_context TEXT NOT NULL,
  PRIMARY KEY(owner_id,effect_kind,effect_id)
);

-- Keep every editing peer's constraint without replacing the original command.
CREATE TABLE fleet_effect_edit_authorizations (
  owner_id TEXT NOT NULL,
  effect_kind TEXT NOT NULL CHECK(effect_kind IN ('run','steering','scheduled')),
  effect_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  grant_context TEXT NOT NULL,
  PRIMARY KEY(owner_id,effect_kind,effect_id,command_id)
);
