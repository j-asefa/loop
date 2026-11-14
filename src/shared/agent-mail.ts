import { AgentAddressId } from "./contract-ids.js";
import {
  AgentId,
  ConversationId,
  MailId,
  MailThreadId,
} from "./contract-ids.js";
import { z } from "zod";
import { MachineId } from "./fleet.js";

// Messages Loop submits on your behalf, not typed by you: a watched pull
// request, a Social feed digest, or another agent's message or delegated
// result.
const AutomationId = z.string().min(1);
export type Automation =
  | { kind: "review_continuation"; reviewId: string }
  | { kind: "github_watch"; watchId: string }
  | { kind: "feed_digest"; digestId: string }
  | {
      kind: "agent_message" | "agent_result";
      mailId: string;
      threadId: string;
      fromAgentId: string;
      fromName: string;
    };
// Validate the existing command type while retaining extra serialized JSON fields.
export const Automation: z.ZodType<Automation> = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("review_continuation"), reviewId: AutomationId })
    .catchall(z.json()),
  z
    .object({ kind: z.literal("github_watch"), watchId: AutomationId })
    .catchall(z.json()),
  z
    .object({ kind: z.literal("feed_digest"), digestId: AutomationId })
    .catchall(z.json()),
  z
    .object({
      kind: z.enum(["agent_message", "agent_result"]),
      mailId: AutomationId,
      threadId: AutomationId,
      fromAgentId: AutomationId,
      fromName: z.string(),
    })
    .catchall(z.json()),
]);

export function automationLabel(
  kind: string | null | undefined,
  fromName?: string | null,
) {
  if (kind === "github_watch") return "GitHub update";
  if (kind === "feed_digest") return "Feed digest";
  if (kind === "review_continuation") return "Review follow-up";
  const from = fromName ? `@${fromName}` : "another agent";
  if (kind === "agent_message") return `Message from ${from}`;
  if (kind === "agent_result") return `Result from ${from}`;
  return "You";
}

export const MailStatusSchema = z.enum([
  "pending",
  "transport_pending",
  "held",
  "not_delivered",
  "steering",
  "steered",
  "unconfirmed",
  "queued",
  "reading",
  "handled",
  "failed",
  "cancelled",
  "interrupted",
]);
export type MailStatus = z.infer<typeof MailStatusSchema>;
const Text = z.string();
export const PublicMailAgentReference = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("local"),
    agentId: AgentId,
    name: Text.nullable(),
  }),
  z.object({
    kind: z.literal("peer"),
    machineId: MachineId,
    agentId: AgentId,
    name: Text.nullable(),
  }),
]);
export type PublicMailAgentReference = z.infer<typeof PublicMailAgentReference>;
const PublicMailConversationReference = z.object({
  machineId: MachineId,
  conversationId: ConversationId.uuid(),
});
const ThreadFields = { scope: z.enum(["direct", "team"]), subject: Text };
const MessageFields = {
  kind: z.enum(["message", "result"]),
  status: MailStatusSchema,
};
export const PublicMailMessage = z.object({
  ...MessageFields,
  id: MailId,
  from: AgentAddressId,
  to: AgentAddressId,
  preview: Text,
  created_at: z.number(),
  error: Text.nullable(),
  files: z.number(),
  conversation_id: ConversationId.nullable(),
  // Machine-qualified references are present only for fleet mail.
  from_ref: PublicMailAgentReference.optional(),
  to_ref: PublicMailAgentReference.optional(),
  remote_conversation: PublicMailConversationReference.nullable().optional(),
});
const PublicMailThread = z.object({
  ...ThreadFields,
  id: MailThreadId,
  paused_at: z.number().nullable(),
  paused_reason: Text.nullable(),
  updated_at: z.number(),
  participants: z.array(AgentAddressId),
  participant_refs: z.array(PublicMailAgentReference).optional(),
  messages: z.array(PublicMailMessage),
});
export type MailThread = z.infer<typeof PublicMailThread>;
export const PublicMailThreads = z.object({
  threads: z.array(PublicMailThread),
});
export const PublicMailResume = z.object({
  released: z.number(),
  refused: z.number(),
  held: z.number(),
});
// The tool's existing privacy-filtered view keeps handles/ISO dates and redacted
// previews; the browser uses owner-visible IDs/timestamps. Share semantic fields
// without changing either wire format or granting the agent the owner's view.
const ToolMailMessage = z.object({
  ...MessageFields,
  messageId: MailId,
  from: Text,
  to: Text,
  sentAt: Text,
  preview: Text.nullable(),
  error: Text.optional(),
});
const ToolMailThread = z.object({
  ...ThreadFields,
  threadId: MailThreadId,
  paused: z.boolean(),
});
export const ToolMailStatus = z.union([
  ToolMailThread.extend({
    pausedReason: Text.optional(),
    messages: z.array(ToolMailMessage),
  }),
  z.object({
    threads: z.array(
      ToolMailThread.extend({ last: ToolMailMessage.optional() }),
    ),
  }),
]);

export const MAIL_STATUS_LABELS: Record<MailStatus, string> = {
  pending: "Waiting for recipient availability",
  transport_pending: "Waiting for destination acceptance",
  held: "Held: thread paused",
  not_delivered: "Not delivered",
  steering: "Waiting to be read mid-task",
  steered: "Read mid-task",
  unconfirmed: "Delivery unconfirmed, not resent",
  queued: "Queued",
  reading: "Being read",
  handled: "Handled",
  failed: "Recipient's turn failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};
