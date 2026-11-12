import { PullStateSchema } from "./pull-state.js";
import { VerificationSummarySchema } from "./verification.js";
import { CheckoutSummarySchema } from "./checkout.js";
import { z } from "zod";
import { PublicRun } from "./run-contract-schema.js";
import { ConversationOrigin } from "./origins.js";
import { MessageRole } from "./message-roles.js";

const text = z.string().nullable();
const time = z.number().nonnegative();
// The Done card uses a declared projection of the canonical run arms.
// Presentation-only error and queue values remain nullable in every state.
const RunPresentation = {
  error: text,
  connection_id: text,
  model: text,
  resolved_model: text,
  queue_position: z.number().nullable(),
  can_move_up: z.boolean(),
  can_move_down: z.boolean(),
  automation: z.string().optional(),
  automation_from: text.optional(),
  checkout: CheckoutSummarySchema.optional(),
  verification: VerificationSummarySchema.optional(),
};
const pickRun = {
  id: true,
  state: true,
  input: true,
  created_at: true,
  updated_at: true,
} as const;
export const DoneRunSchema = z.discriminatedUnion("state", [
  PublicRun.options[0].pick(pickRun).extend(RunPresentation),
  PublicRun.options[1].pick(pickRun).extend(RunPresentation),
  PublicRun.options[2].pick(pickRun).extend(RunPresentation),
  PublicRun.options[3].pick(pickRun).extend(RunPresentation),
  PublicRun.options[4].pick(pickRun).extend(RunPresentation),
  PublicRun.options[5].pick(pickRun).extend(RunPresentation),
  PublicRun.options[6].pick(pickRun).extend(RunPresentation),
  PublicRun.options[7].pick(pickRun).extend(RunPresentation),
  PublicRun.options[8].pick(pickRun).extend(RunPresentation),
  PublicRun.options[9].pick(pickRun).extend(RunPresentation),
]);
const FeedRunExtra = {
  created_at: time,
  updated_at: time,
  can_move_up: z.boolean().optional(),
  can_move_down: z.boolean().optional(),
  checkout: CheckoutSummarySchema.nullable().optional(),
  verification: VerificationSummarySchema.nullable().optional(),
};
export const FeedRunSchema = z.discriminatedUnion("state", [
  DoneRunSchema.options[0].extend(FeedRunExtra),
  DoneRunSchema.options[1].extend(FeedRunExtra),
  DoneRunSchema.options[2].extend(FeedRunExtra),
  DoneRunSchema.options[3].extend(FeedRunExtra),
  DoneRunSchema.options[4].extend(FeedRunExtra),
  DoneRunSchema.options[5].extend(FeedRunExtra),
  DoneRunSchema.options[6].extend(FeedRunExtra),
  DoneRunSchema.options[7].extend(FeedRunExtra),
  DoneRunSchema.options[8].extend(FeedRunExtra),
  DoneRunSchema.options[9].extend(FeedRunExtra),
]);
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
  run: DoneRunSchema.nullable(),
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
