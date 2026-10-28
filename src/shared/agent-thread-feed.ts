import { z } from "zod";
import { PublicMailMessage } from "./agent-mail.js";
import { CardSelectionSchema } from "./cards.js";

export const AgentThreadQuery = CardSelectionSchema.pick({
  project: true,
  agent: true,
  teams: true,
})
  .extend({
    view: z.enum(["done", "threads"]).default("threads"),
    before: z.string().min(1).max(1024).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(40),
  })
  .strict();
export const AgentThreadMessagesQuery = AgentThreadQuery.pick({
  before: true,
  limit: true,
});
export const AgentThreadSummary = z.object({
  id: z.string(),
  subject: z.string(),
  scope: z.enum(["direct", "team"]),
  updated_at: z.number(),
  paused_at: z.number().nullable(),
  paused_reason: z.string().nullable(),
  participants: z.array(z.object({ id: z.string(), name: z.string() })),
  message_count: z.number().int().positive(),
  latest: PublicMailMessage,
});
export const AgentThreadPage = z.object({
  items: z.array(AgentThreadSummary),
  next: z.string().nullable(),
});
export const AgentThreadMessage = PublicMailMessage.extend({
  content: z.string(),
  message_id: z.string().nullable(),
  attachments: z.array(z.object({ id: z.string(), name: z.string() })),
});
export const AgentThreadDetail = z.object({
  thread: AgentThreadSummary,
  messages: z.array(AgentThreadMessage),
  next: z.string().nullable(),
});
export type AgentThreadSummary = z.infer<typeof AgentThreadSummary>;
export type AgentThreadPage = z.infer<typeof AgentThreadPage>;
export type AgentThreadMessage = z.infer<typeof AgentThreadMessage>;
export type AgentThreadDetail = z.infer<typeof AgentThreadDetail>;
