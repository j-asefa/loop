import { z } from "zod";
import { ProviderSchema as Provider } from "./provider-schema.js";
import { PERMISSION_MODES } from "./permission-modes.js";
const Id = z.string().min(1);
export const PermissionMode = z.enum(
  PERMISSION_MODES.map((mode) => mode.value),
);
export const Reply = z.strictObject({
  id: Id,
  content: z.string(),
  name: z.string(),
  created_at: z.number(),
  mine: z.boolean().optional(),
  excerpt: z.boolean().optional(),
});
export const Source = z.strictObject({
  url: z.string(),
  title: z.string(),
  excerpt: z.string(),
});
export const UploadedFile = z.strictObject({
  id: Id,
  objectId: Id,
  name: z.string(),
  mime: z.string(),
  size: z.number().nonnegative(),
  published: z.boolean().optional(),
});
export const AgentSnapshot = z.strictObject({
  agentId: Id,
  name: z.string(),
  provider: Provider,
  connectionId: Id,
  model: z.string().min(1),
  resolvedModel: z.string().optional(),
  effort: z.string().nullable().optional(),
  permissionMode: PermissionMode.optional(),
  instructions: z.string(),
  folderId: Id.nullable(),
  maxTokens: z.number().int().positive().optional(),
  maxSeconds: z.number().positive().optional(),
  source: Source.optional(),
  teamId: Id.optional(),
  reviewId: Id.optional(),
  attachmentIds: z.array(Id).optional(),
  mailId: Id.optional(),
  replyTo: Reply.optional(),
  previewFixture: z.boolean().optional(),
});
export type AgentSnapshot = z.infer<typeof AgentSnapshot>;
