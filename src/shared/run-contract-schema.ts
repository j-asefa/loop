import { z } from "zod";
import { Text, MaybeText, Time } from "./route-contract.js";
import { RunDisplayState, RunKind } from "./run-state.js";
import { PublicArtifact } from "./artifact-contract-schema.js";
// Run arms follow storage transitions and every public projection. Preview and
// queue fields are shared: attention(active=false) returns them for every state,
// and queue_rank is retained when a queued run starts.
const RunBaseSchema = z.object({
  id: Text,
  owner_id: Text.optional(),
  agent_id: MaybeText,
  conversation_id: MaybeText,
  kind: RunKind.optional(),
  input: Text,
  idempotency_key: Text.optional(),
  payload: Text,
  created_at: Time,
  updated_at: Time,
  active_ms: z.number().optional(),
  // Native error events write this independently of run state; transitions do
  // not generally clear it, including a later successful completion.
  error: MaybeText.optional(),
  steeringId: Text.optional(),
  queue_rank: z.number().nullable().optional(),
  queue_position: z.number().nullable().optional(),
  preview: MaybeText.optional(),
  preview_artifact: PublicArtifact.nullable().optional(),
});
const RunLeaseSchema = z.object({
  worker_id: MaybeText.optional(),
  heartbeat: Time.nullable().optional(),
});
const RunOutcomeSchema = z.object({
  result: MaybeText.optional(),
});
const RunAttentionSchema = z.object({
  attention_dismissed_at: Time.nullable().optional(),
});
function runArm<
  S extends RunDisplayState,
  E extends Record<string, z.ZodTypeAny>,
>(state: S, extra: E) {
  return RunBaseSchema.extend({ state: z.literal(state), ...extra });
}
export const PublicRun = z.discriminatedUnion("state", [
  runArm("queued", {}),
  runArm("waiting_children", {}),
  runArm("running", {
    ...RunLeaseSchema.shape,
    result: MaybeText.optional(),
  }).extend({
    active_since: Time.nullable().optional(),
  }),
  runArm("pausing", {
    ...RunLeaseSchema.shape,
    result: MaybeText.optional(),
  }).extend({
    active_since: Time.nullable().optional(),
  }),
  runArm("paused", {
    result: MaybeText.optional(),
    ...RunLeaseSchema.shape,
  }),
  runArm("awaiting_approval", {
    worker_id: MaybeText,
    heartbeat: Time.nullable().optional(),
  }),
  runArm("interrupted", RunOutcomeSchema.shape)
    .extend(RunLeaseSchema.shape)
    .extend(RunAttentionSchema.shape),
  runArm("completed", {
    result: MaybeText.optional(),
    worker_id: MaybeText.optional(),
    heartbeat: Time.nullable().optional(),
  }),
  runArm("failed", RunOutcomeSchema.shape)
    .extend(RunLeaseSchema.shape)
    .extend(RunAttentionSchema.shape),
  runArm("cancelled", RunOutcomeSchema.shape)
    .extend(RunLeaseSchema.shape)
    .extend(RunAttentionSchema.shape),
]);
