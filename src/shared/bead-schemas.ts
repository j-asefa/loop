import { z } from "zod";

export const BeadId = z
  .string()
  .regex(/^loop-[a-z0-9]+(?:[.-][a-z0-9]+)*$/)
  .max(128);
export const StoreId = z.string().regex(/^[a-f0-9]{64}$/);
export const RequestId = z.uuid();
const Status = z.enum(["ready", "in_progress", "blocked", "closed"]);
const WorkItem = z.object({
  id: BeadId,
  title: z.string(),
  description: z.string(),
  status: Status,
  dependencies: z.array(BeadId),
  blockedBy: z.array(BeadId),
  assignee: z.string().nullable(),
});
export const WorkState = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false) }),
  z.object({
    enabled: z.literal(true),
    storeId: StoreId,
    items: z.array(WorkItem),
  }),
]);
const PublicComment = z.object({
  id: z.string(),
  author: z.string(),
  text: z.string(),
  createdAt: z.string(),
});
const ResultReference = z.object({
  id: z.string(),
  conversationId: z.string(),
  messageId: z.string(),
  title: z.string(),
});
export const Assignment = z.object({
  requestId: RequestId,
  generation: RequestId,
  agentId: z.string(),
  state: z.enum([
    "prepared",
    "claiming",
    "claimed",
    "started",
    "releasing",
    "released",
    "refused",
  ]),
  canResume: z.boolean(),
  canRelease: z.boolean(),
  conversationId: z.string().nullable(),
  result: ResultReference.nullable(),
  pulls: z.array(z.url()),
});
export const WorkDetail = WorkItem.extend({
  storeId: StoreId,
  comments: z.array(PublicComment),
  sourceResultId: z.string().nullable(),
  sourceResult: ResultReference.nullable(),
  closeReason: z.string().nullable(),
  assignment: Assignment.nullable(),
  linkedRuns: z.array(Assignment),
});
export const Create = z.object({
  storeId: StoreId,
  requestId: RequestId,
  title: z.string().trim().min(1).max(256),
  description: z.string().max(16_000).default(""),
  sourceResultId: z.string().min(1).max(256).optional(),
  sourceMessageId: z.string().min(1).max(256).optional(),
});
export const Comment = z.object({
  storeId: StoreId,
  requestId: RequestId,
  text: z.string().trim().min(1).max(8000),
  excerpt: z.string().trim().min(1).max(4000).optional(),
});
export const WriteStatus = z.object({
  status: z.enum(["committed", "unknown", "refused"]),
  beadId: BeadId,
});
export type BeadCreate = z.output<typeof Create>;
export type BeadComment = z.output<typeof Comment>;
export type BeadWorkItem = z.output<typeof WorkItem>;
export type BeadWorkState = z.output<typeof WorkState>;
export type BeadDetail = z.output<typeof WorkDetail>;
export type BeadAssignmentView = z.output<typeof Assignment>;
export type BeadWriteStatus = z.output<typeof WriteStatus>;
