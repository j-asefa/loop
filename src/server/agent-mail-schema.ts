import { z } from "zod";
import { MailSourceId } from "../shared/fleet-mail-discovery.js";

export const messageSchema = z.object({
  to: z
    .string()
    .min(1)
    .max(200)
    .describe("The recipient agentId from loop55_agents."),
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
      "Deliver into the recipient's running task where live input is supported. Direct messages select its most recent running conversation, even with threadId; conversationId overrides this. Otherwise normal routing and queuing apply.",
    ),
  fileIds: z
    .array(z.string().uuid())
    .max(8)
    .default([])
    .describe(
      "Files you published with loop55_publish_file, or files attached to your conversation. The recipient reads them with loop55_read_file.",
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
      "Select a direct recipient conversation. With interrupt, overrides automatic selection even in an existing thread; otherwise replies keep their stored destination.",
    ),
});
export const directorySchema = z.object({
  sourceId: MailSourceId.optional().describe(
    "Omit for this machine. Use a sourceId from sources to discover agents on another authorized machine; offsets belong to that source.",
  ),
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
