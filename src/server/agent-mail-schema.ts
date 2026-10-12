import { z } from "zod";

export const messageSchema = z.object({
  to: z
    .string()
    .min(1)
    .max(200)
    .describe("The recipient agentId from loop_agents."),
  body: z.string().trim().min(1).max(12000),
  threadId: z
    .string()
    .max(200)
    .optional()
    .describe("Reply in this thread. Omit to start a new thread."),
  interrupt: z
    .boolean()
    .default(false)
    .describe(
      "Deliver into the recipient's bound running task now, where its runtime takes live input. By default the message waits until that task finishes.",
    ),
  fileIds: z
    .array(z.string().uuid())
    .max(8)
    .default([])
    .describe(
      "Files you published with loop_publish_file, or files attached to your conversation. The recipient reads them with loop_read_file.",
    ),
  // Optional, without defaults: old persisted request identities stay valid.
  scope: z
    .enum(["direct", "team"])
    .optional()
    .describe(
      "Omit to use the active shared team, otherwise direct. Replies retain their thread's scope.",
    ),
  conversationId: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Select the recipient's conversation for a new direct thread. Replies keep the stored binding.",
    ),
});
export const directorySchema = z.object({
  query: z.string().trim().max(200).optional(),
  offset: z.number().int().min(0).max(100000).default(0),
  limit: z.number().int().min(1).max(50).default(20),
});
export const statusSchema = z.object({
  threadId: z
    .string()
    .max(200)
    .optional()
    .describe("List this thread's messages. Omit to list your recent threads."),
});
