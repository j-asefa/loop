import { z } from "zod";

// Messages Loop submits on your behalf, not typed by you: a watched pull
// request, a Social feed digest, or another agent's message or delegated
// result.
export type Automation =
  | { kind: "github_watch"; watchId: string }
  | { kind: "feed_digest"; digestId: string }
  | {
      kind: "agent_message" | "agent_result";
      mailId: string;
      threadId: string;
      fromAgentId: string;
      fromName: string;
    };

export function automationLabel(
  kind: string | null | undefined,
  fromName?: string | null,
) {
  if (kind === "github_watch") return "GitHub update";
  if (kind === "feed_digest") return "Feed digest";
  const from = fromName ? `@${fromName}` : "another agent";
  if (kind === "agent_message") return `Message from ${from}`;
  if (kind === "agent_result") return `Result from ${from}`;
  return "You";
}

export const MailStatusSchema = z.enum([
  "pending",
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
const ThreadFields = { scope: z.enum(["direct", "team"]), subject: Text };
const MessageFields = {
  kind: z.enum(["message", "result"]),
  status: MailStatusSchema,
};
export const PublicMailMessage = z.object({
  ...MessageFields,
  id: Text,
  from: Text,
  to: Text,
  preview: Text,
  created_at: z.number(),
  // Recipient navigation was added with direct mail in 3ae55ca7.
  error: Text.nullable(),
  files: z.number(),
  conversation_id: Text.nullable().optional(),
});
export const PublicMailThread = z.object({
  ...ThreadFields,
  // The original team-mail HTTP projection did not return scope (3ae55ca7).
  scope: ThreadFields.scope.optional(),
  id: Text,
  paused_at: z.number().nullable(),
  paused_reason: Text.nullable(),
  updated_at: z.number(),
  participants: z.array(Text),
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
  messageId: Text,
  from: Text,
  to: Text,
  sentAt: Text,
  preview: Text.nullable(),
  error: Text.optional(),
});
const ToolMailThread = z.object({
  ...ThreadFields,
  threadId: Text,
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
