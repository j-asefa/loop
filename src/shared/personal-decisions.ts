import { z } from "zod";

export const PersonalDecisionsQuery = z.object({
  kind: z.enum(["approval", "answer"]),
  before: z.string().min(1).max(512).optional(),
});

export const PERSONAL_DECISION_DETAIL_LIMIT = 8192;
export const PERSONAL_DECISION_RESPONSE_LIMIT = 8192;
export const PERSONAL_DECISIONS_PAGE_LIMIT = 2 * 1024 * 1024;

const jsonBytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;

// A public display contract, independent of execution receipts and raw rows.
const PersonalDecisionSchema = z.strictObject({
  id: z.string(),
  cursor: z.string().min(1).max(512),
  kind: z.enum(["approval", "answer"]),
  title: z.string().max(1024),
  detail: z.string().max(PERSONAL_DECISION_DETAIL_LIMIT),
  detail_truncated: z.boolean(),
  choice: z.string().max(256).nullable(),
  answers: z
    .array(
      z.strictObject({
        question: z.string().max(512),
        values: z.array(z.string().max(8000)).max(30).nullable(),
        secret: z.boolean(),
      }),
    )
    .max(50)
    .refine(
      (answers) => jsonBytes(answers) <= PERSONAL_DECISION_RESPONSE_LIMIT,
    ),
  response_recorded: z.boolean(),
  response_truncated: z.boolean(),
  state: z.enum(["pending", "deciding", "resolved", "unknown", "expired"]),
  created_at: z.number().int().nonnegative().safe(),
  conversation_id: z.string().nullable(),
  conversation_title: z.string().max(1024).nullable(),
  agent_name: z.string().max(256).nullable(),
});
export const PersonalDecisionsPageSchema = z
  .strictObject({
    items: z.array(PersonalDecisionSchema).max(50),
    next: z.string().nullable(),
  })
  .refine((page) => jsonBytes(page) <= PERSONAL_DECISIONS_PAGE_LIMIT);
export type PersonalDecision = z.infer<typeof PersonalDecisionSchema>;
export type PersonalDecisionsPage = z.infer<typeof PersonalDecisionsPageSchema>;

// Full display fields for one recorded approval. Installation configuration,
// execution receipts and native session context never cross this boundary.
export const PersonalApprovalSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("approval"),
    request: z.object({
      type: z.string().optional(),
      tool: z.string().optional(),
      server: z.string().optional(),
      message: z.string().optional(),
      content: z.string().optional(),
      arguments: z.unknown().optional(),
    }),
  }),
  z.object({
    source: z.literal("native"),
    request: z.object({
      title: z.string(),
      detail: z.string().optional(),
    }),
  }),
]);
export type PersonalApproval = z.infer<typeof PersonalApprovalSchema>;
