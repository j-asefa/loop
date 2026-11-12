import { PullStateSchema } from "./pull-state.js";
import { VerificationSummarySchema } from "./verification.js";
import { CheckoutSummarySchema } from "./checkout.js";
import { z } from "zod";
import { RunDisplayState } from "./run-state.js";
import { ConversationOrigin } from "./origins.js";
import { MessageRole } from "./message-roles.js";

const text = z.string().nullable();
const time = z.number().nonnegative();
// Session-only presentation data. Runtime actions still use the Feed contract.
export const DoneDisplaySchema = z.object({
  conversation_id: z.string(),
  done_card_key: text,
  title: z.string(),
  agent_id: text,
  connection_id: text,
  agent_name: text,
  provider: text,
  project_id: text,
  project_name: text,
  team_id: text,
  origin: ConversationOrigin,
  last_activity_at: time,
  last_message: z
    .object({
      id: z.string(),
      role: MessageRole,
      preview: z.string(),
      content: z.string(),
      created_at: time,
      saved: z.boolean(),
      automation: z.string().optional(),
      automation_from: z.string().optional(),
    })
    .nullable(),
  run: z
    .object({
      id: z.string(),
      state: RunDisplayState,
      error: text,
      input: z.string(),
      connection_id: text,
      model: text,
      resolved_model: text,
      created_at: time,
      updated_at: time,
      queue_position: z.number().nullable(),
      can_move_up: z.boolean(),
      can_move_down: z.boolean(),
      automation: z.string().optional(),
      automation_from: text.optional(),
      checkout: CheckoutSummarySchema.optional(),
      verification: VerificationSummarySchema.optional(),
    })
    .nullable(),
  pull: PullStateSchema.nullable(),
  // When the owner opened this result; null while unread. Absent for idle
  // threads and for sources that do not record reads.
  read_at: time.nullable().optional(),
  unread_version: z.number().int().nonnegative().safe().optional(),
  // Reading position belongs to the operational Feed contract.
  position_message_id: z.null().default(null),
  later: z
    .object({
      id: z.string(),
      due_at: time.nullable(),
      condition: z.string(),
      surfaced_at: time.nullable(),
    })
    .nullable(),
  next_action: z
    .object({ kind: z.literal("result"), message_id: text, run_id: z.string() })
    .nullable(),
});
