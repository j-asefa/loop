-- Retire generated project records and their producers. Primary messages,
-- saved results, folders, runs, approvals and card revisions remain intact.
-- Keep project_change_folders: results and Cards API use this owner-scoped view.
DROP TRIGGER IF EXISTS brief_pr_citation_recorded;
DROP TRIGGER IF EXISTS project_brief_due;
DROP TRIGGER IF EXISTS project_change_artifact_archived;
DROP TRIGGER IF EXISTS project_change_artifact_deleted;
DROP TRIGGER IF EXISTS project_change_artifact_edited;
DROP TRIGGER IF EXISTS project_change_artifact_moved;
DROP TRIGGER IF EXISTS project_change_artifact_restored;
DROP TRIGGER IF EXISTS project_change_conversation_deleted;
DROP TRIGGER IF EXISTS project_change_conversation_entering;
DROP TRIGGER IF EXISTS project_change_conversation_leaving;
DROP TRIGGER IF EXISTS project_change_folder_entering;
DROP TRIGGER IF EXISTS project_change_folder_leaving;
DROP TRIGGER IF EXISTS project_change_message_deleted;
DROP TRIGGER IF EXISTS project_change_prompt_edited;
DROP TRIGGER IF EXISTS project_change_result;

DROP VIEW project_change_entries;
DROP VIEW project_change_sources;
DROP TABLE project_changes;
DROP TABLE brief_deliveries;
DROP TABLE brief_acks;
DROP TABLE brief_generation_usage;
DROP TABLE project_briefs;
DROP TABLE brief_state;
-- Remove self-references before dropping the ledger with foreign keys enabled.
UPDATE brief_items SET supersedes=NULL;
DROP TABLE brief_items;
DROP TABLE deployment_observations;
DROP TABLE checkout_build_targets;
-- Recapture archives existed only to resolve the removed Brief citations.
DROP TABLE run_checkout_versions;
UPDATE messages SET metadata=json_remove(metadata,'$.brief_pr_refs')
WHERE json_type(metadata,'$.brief_pr_refs') IS NOT NULL;
INSERT INTO schema_version VALUES(100,unixepoch()*1000);
