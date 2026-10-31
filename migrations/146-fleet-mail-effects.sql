-- A remote Resume releases one held message; its grant must survive offline
-- queuing without constraining unrelated work from the original sender run.
CREATE TABLE fleet_mail_effects (
  mail_id TEXT PRIMARY KEY REFERENCES fleet_mail_dispatch(mail_id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  grant_context TEXT NOT NULL CHECK(json_valid(grant_context))
);
