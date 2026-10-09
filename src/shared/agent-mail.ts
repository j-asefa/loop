// Messages Loop submits on your behalf, not typed by you: a watched pull
// request, a Social feed digest, or a teammate agent's message or delegated
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
  const from = fromName ? `@${fromName}` : "a teammate";
  if (kind === "agent_message") return `Message from ${from}`;
  if (kind === "agent_result") return `Result from ${from}`;
  return "You";
}

export type MailStatus =
  | "held"
  | "not_delivered"
  | "steering"
  | "steered"
  | "unconfirmed"
  | "queued"
  | "reading"
  | "handled"
  | "failed"
  | "cancelled"
  | "interrupted";

export const MAIL_STATUS_LABELS: Record<MailStatus, string> = {
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
