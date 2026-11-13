import { ApprovalId, ConversationId, OwnerId, RunId } from "./contract-ids.js";
import { z } from "zod";
import { Text, MaybeText, Time } from "./route-contract.js";
import { ProviderSchema } from "./provider-schema.js";
import type { ApprovalState } from "./approvals.js";

// Public approval fields retained by every lifecycle writer. Expiry remains
// stored after a decision; result is opaque text, not a decoded tool payload.
const CommonApproval = z.object({
  id: ApprovalId,
  owner_id: OwnerId,
  run_id: RunId,
  digest: Text,
  request: Text,
  created_at: Time,
  expires_at: Time,
  conversation_id: ConversationId.nullable(),
  input: Text,
  name: MaybeText,
  provider: ProviderSchema.nullable(),
});
function arm<S extends ApprovalState, R extends z.ZodTypeAny>(
  state: S,
  result: R,
) {
  return CommonApproval.extend({ state: z.literal(state), result });
}
export const Approval = z.discriminatedUnion("state", [
  arm("pending", z.null()),
  arm("approved", z.null()),
  arm("executing", z.null()),
  // Ordinary rejection retains NULL; the design preview saves a message.
  arm("rejected", MaybeText),
  arm("completed", Text),
  // Uncertainty writers always save a diagnostic; this never permits replay.
  arm("unknown", Text),
]);
export type Approval = z.infer<typeof Approval>;
