import { z } from "zod";
import { CardSelectionSchema, DoneCardSchema } from "./cards.js";

export const DoneThreadCardId = z
  .string()
  .regex(/^d:(run|message):[^/\\?#\s]+$/)
  .max(160);
export const DoneThreadMembers = z
  .object({ cardIds: z.array(DoneThreadCardId).min(1).max(100) })
  .strict();
export const DoneThreadCreate = DoneThreadMembers.extend({
  id: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
}).strict();
export const DoneThread = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.number(),
  cardIds: z.array(DoneThreadCardId),
});
export const DoneThreadQuery = CardSelectionSchema.pick({
  project: true,
  agent: true,
  teams: true,
}).strict();
export const DoneThreadSummary = DoneThread.extend({
  // Keep every destination available when organizing within a filtered feed.
  // Only threads with a matching preview appear in Done and Threads.
  preview: DoneCardSchema.nullable(),
});
export const DoneThreadDetail = z.object({
  thread: DoneThread,
  cards: z.array(DoneCardSchema),
});
export type DoneThread = z.infer<typeof DoneThread>;
export type DoneThreadQuery = z.infer<typeof DoneThreadQuery>;
export type DoneThreadSummary = z.infer<typeof DoneThreadSummary>;
export type DoneThreadDetail = z.infer<typeof DoneThreadDetail>;
