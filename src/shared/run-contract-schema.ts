import { IdempotencyKey } from "./contract-ids.js";
import { SteeringId, WorkerId } from "./contract-ids.js";
import { AgentId, ConversationId, OwnerId, RunId } from "./contract-ids.js";
import { z } from "zod";
import { Text, MaybeText, Time } from "./route-contract.js";
import { RunDisplayState, RunKind } from "./run-state.js";
import { PublicArtifact } from "./artifact-contract-schema.js";
// State remains discriminated, but the public wire fields preserve v0.1.0.
// Nullable outcome/lease fields can survive a transition and cannot be stripped
// just because they are not evidence of work in the current state.
const RunBaseSchema = z.object({
  id: RunId,
  owner_id: OwnerId.optional(),
  agent_id: AgentId.nullable(),
  conversation_id: ConversationId.nullable(),
  kind: RunKind.optional(),
  input: Text,
  idempotency_key: IdempotencyKey.optional(),
  payload: Text,
  created_at: Time,
  updated_at: Time,
  active_ms: z.number().optional(),
  // Native error events write this independently of run state; transitions do
  // not generally clear it, including a later successful completion.
  error: MaybeText.default(null),
  result: MaybeText.default(null),
  worker_id: WorkerId.nullable().optional(),
  heartbeat: Time.nullable().optional(),
  active_since: Time.nullable().optional(),
  attention_dismissed_at: Time.nullable().optional(),
  steeringId: SteeringId.optional(),
  queue_rank: z.number().nullable().optional(),
  queue_position: z.number().nullable().optional(),
  preview: MaybeText.optional(),
  preview_artifact: PublicArtifact.nullable().optional(),
});
function runArm<S extends RunDisplayState>(state: S) {
  return RunBaseSchema.extend({ state: z.literal(state) });
}
export const PublicRun = z.discriminatedUnion("state", [
  runArm("queued"),
  runArm("waiting_children"),
  runArm("running"),
  runArm("pausing"),
  runArm("paused"),
  runArm("awaiting_approval"),
  runArm("interrupted"),
  runArm("completed"),
  runArm("failed"),
  runArm("cancelled"),
]);
