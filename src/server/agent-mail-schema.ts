import { z } from "zod";
import { MailSourceId } from "../shared/fleet-mail-discovery.js";

export const messageSchema = z.object({
  to: z.string().min(1).max(200).describe("agentId from loop_agents."),
  body: z.string().trim().min(1).max(12000),
  threadId: z.string().max(200).optional().describe("Reply thread ID."),
  interrupt: z.boolean().default(false).describe("Steer running task."),
  fileIds: z
    .array(z.string().uuid())
    .max(8)
    .default([])
    .describe("Published/attached file UUIDs."),
  // Optional, without defaults: old persisted request identities stay valid.
  scope: z
    .enum(["direct", "team"])
    .optional()
    .describe("Omit for active team else direct."),
  conversationId: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Direct conversation ID."),
});
export const directorySchema = z.object({
  sourceId: MailSourceId.optional().describe(
    "Omit for local + peer list; pass a peer sourceId to query it.",
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
    .describe("Thread ID; omit for recent threads."),
});
