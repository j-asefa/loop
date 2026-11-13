import { ProjectId, requestId } from "./contract-ids.js";
import {
  MemorySourceKind,
  MemorySourceOrigin,
  MemorySourceRole,
} from "./memory-source.js";
import { z } from "zod";

const Text = z.string();
const MaybeText = Text.nullable();
const Count = z.number();
export const MemoryPolicyInput = z.object({
  scope: Text.max(160),
  enabled: z.boolean(),
});
export const MemoryNoteInput = z.object({
  title: Text.min(1).max(180),
  content: Text.min(1).max(20000),
  projectId: requestId(ProjectId).nullable().default(null),
});
export const MemoryNoteUpdateInput = MemoryNoteInput.omit({
  projectId: true,
}).extend({ revision: Count.int() });

const PublicMemorySummary = z.object({
  id: Text,
  title: Text,
  kind: MemorySourceKind,
  project_id: MaybeText,
  revision: Count,
  eligible: Count,
  tombstone: Count,
});
export const PublicMemoryStatus = z.object({
  policies: z.array(z.object({ scope: Text, enabled: Count })),
  sources: z.array(PublicMemorySummary),
});
const PublicMemorySourceFields = PublicMemorySummary.extend({
  owner_id: Text,
  source_id: Text,
  conversation_id: MaybeText,
  message_id: MaybeText,
  agent_id: MaybeText,
  origin: MemorySourceOrigin,
  role: MemorySourceRole,
  content_hash: Text,
  content: Text,
  complete: Count,
  created_at: Count,
  updated_at: Count,
});
// Notes are editable even when recall is disabled. Historical sources include
// their original link and may have a shortened display excerpt.
export const PublicMemorySource = z.union([
  PublicMemorySourceFields.extend({
    kind: z.literal("note"),
    truncated: z.literal(false),
  }),
  PublicMemorySourceFields.extend({ truncated: z.boolean(), link: Text }),
]);
const Receipt = z.object({
  mode: z.enum(["disabled", "lexical"]),
  sources: Text,
  tokens: Count,
});
export const PublicMemoryReceipt = z.union([
  Receipt.extend({ run_id: Text, created_at: Count }),
  z.object({
    mode: z.literal("not-used"),
    sources: z.literal("[]"),
    tokens: z.literal(0),
  }),
]);
export const PublicMemoryVersions = z.array(
  z.object({ revision: Count, title: Text, content: Text, created_at: Count }),
);
