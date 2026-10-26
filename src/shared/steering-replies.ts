import { z } from "zod";

export const PublishReply = z.strictObject({
  replyTo: z.string().min(1).max(150).describe("The message ID supplied with the user's steered message."),
  body: z.string().trim().min(1).max(30000).describe("Your complete reply to that message."),
});

// Express the nonempty update in JSON Schema too, not only a runtime refine.
export const ReplyState = z.union([
  z.strictObject({ read: z.literal(true), archived: z.boolean().optional() }),
  z.strictObject({ read: z.literal(true).optional(), archived: z.boolean() }),
]);

export const ReplyContext = z.object({
  message_id: z.string(),
  content: z.string(),
  read_at: z.number().nullable(),
});

/** Only Loop's delivery wrapper supplies the identity; quoting one in ordinary
 * assistant text never publishes a reply. Agent mail keeps its own protocol. */
export function steeredReplyPrompt(content: string, messageId: string) {
  return `The user sent this message while your task was running. Message ID: ${messageId}\n` +
    `When answering this message, publish the answer with loop_reply using replyTo "${messageId}" and body containing your complete reply. You may publish more than one reply. Continue the ongoing task unless the user redirects or stops it; publishing a reply does not finish the task.\n\n${content}`;
}
