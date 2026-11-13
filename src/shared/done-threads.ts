import { DoneThreadId, requestId } from "./contract-ids.js";
import { DONE_CARD_PREFIX } from "./done-card-id.js";
import { z } from "zod";
import { CardSelectionSchema, DoneCardSchema } from "./cards.js";
import { DoneReadVersions } from "./mobile-contract-schemas.js";

export const MAX_DONE_THREAD_MEMBERS = 100;

export const DoneThreadCardId = z
  .string()
  .regex(new RegExp(`^${DONE_CARD_PREFIX}(run|message):[^/\\\\?#\\s]+$`))
  .max(160);
export const DoneThreadMembers = z
  .object({
    cardIds: z.array(DoneThreadCardId).min(1).max(MAX_DONE_THREAD_MEMBERS),
  })
  .strict();
export const DoneThreadCreate = DoneThreadMembers.extend({
  id: requestId(DoneThreadId).uuid(),
  title: z.string().trim().min(1).max(200),
}).strict();
export const DoneThread = z.object({
  id: DoneThreadId,
  title: z.string(),
  createdAt: z.number(),
  cardIds: z.array(DoneThreadCardId),
});
export const DoneThreadQuery = CardSelectionSchema.pick({
  project: true,
  agent: true,
  teams: true,
}).strict();
export const DoneThreadPageQuery = z
  .object({ cursor: z.string().min(1).max(1024).optional() })
  .strict();
export const DoneThreadListPageQuery = DoneThreadQuery.extend(
  DoneThreadPageQuery.shape,
);
export const DoneThreadSummary = DoneThread.extend({
  // Keep every destination available when organizing within a filtered feed.
  // Only threads with a matching preview appear in Done and Threads.
  preview: DoneCardSchema.nullable(),
  // Members not yet opened; opening the thread reads them all. Absent from
  // sources that do not record Done reads.
  unread: z.number().int().nonnegative().optional(),
  unreadVersions: DoneReadVersions.optional(),
});
export const DoneThreadDetail = z.object({
  thread: DoneThread,
  cards: z.array(DoneCardSchema),
});
export const DoneThreadListPage = z.object({
  threads: z.array(DoneThreadSummary),
  next: z.string().min(1).max(1024).nullable(),
});
export const DoneThreadDetailPage = DoneThreadDetail.extend({
  next: z.string().min(1).max(1024).nullable(),
});
// Leave room for the peer's signed envelope inside its 2 MiB response limit.
export const DONE_THREAD_PAGE_BYTES = 1_900_000;
export const DONE_THREAD_PAGE_ITEMS = 20;
export type DoneThread = z.infer<typeof DoneThread>;
export type DoneThreadQuery = z.infer<typeof DoneThreadQuery>;
export type DoneThreadSummary = z.infer<typeof DoneThreadSummary>;
export type DoneThreadDetail = z.infer<typeof DoneThreadDetail>;
export type DoneThreadListPage = z.infer<typeof DoneThreadListPage>;
export type DoneThreadDetailPage = z.infer<typeof DoneThreadDetailPage>;
