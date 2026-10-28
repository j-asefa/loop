import { z } from "zod";
import { workflowSchema } from "./workflow-schema.js";
import { ProviderSchema } from "./provider-schema.js";

const Text = z.string(),
  MaybeText = Text.nullable(),
  Count = z.number();
export const WorkflowSourceInput = z.object({ source: Text.max(100000) });
export const WorkflowSaveInput = WorkflowSourceInput.extend({
  id: Text.optional(),
  expectedVersion: Count.int().optional(),
});
export const WorkflowRunInput = z.object({
  version: Count.int().min(1),
  inputs: z.record(Text, Text),
  idempotencyKey: Text.min(8).max(150),
});
export const PublicWorkflow = z.object({
  id: Text,
  owner_id: Text,
  title: Text,
  version: Count,
  source: Text,
  compiled: Text,
  created_at: Count,
});
// Validation returns the compiled definition and public binding snapshots today.
// Source/compiled storage columns remain opaque text on saved workflow responses.
export const PublicWorkflowValidation = z.object({
  spec: workflowSchema,
  bindings: z.record(
    Text,
    z.object({
      agentId: Text,
      name: Text,
      provider: ProviderSchema,
      model: Text,
      effort: MaybeText,
      instructions: Text,
      connectionId: Text,
      folderId: MaybeText,
    }),
  ),
  notice: Text,
});
export const PublicWorkflowVersion = z.object({
  version: Count,
  source: Text,
  created_at: Count,
});
export const WorkflowStepFields = {
  run_id: Text,
  step_id: Text,
  position: Count,
  child_run_id: MaybeText,
  approval_id: MaybeText,
  output: MaybeText,
  artifact_id: MaybeText,
};
