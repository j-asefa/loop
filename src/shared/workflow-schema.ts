import { z } from "zod";
const name = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
const agentStep = z
  .object({
    id: name,
    type: z.literal("agent"),
    agent: name,
    prompt: z.string().min(1).max(12000),
  })
  .strict();
const approvalStep = z
  .object({
    id: name,
    type: z.literal("approval"),
    source: name,
    message: z.string().min(1).max(500),
  })
  .strict();
const saveStep = z
  .object({
    id: name,
    type: z.literal("save"),
    source: name,
    title: z.string().min(1).max(180),
    kind: z.enum(["markdown", "code", "table", "diagram"]).default("markdown"),
  })
  .strict();
export const workflowSchema = z
  .object({
    dsl: z.literal("loop.workflow/v1"),
    title: z.string().min(1).max(120),
    inputs: z.record(
      name,
      z
        .object({
          description: z.string().max(300),
          default: z.string().max(5000).optional(),
        })
        .strict(),
    ),
    agents: z.record(name, z.string().min(1)),
    steps: z
      .array(z.discriminatedUnion("type", [agentStep, approvalStep, saveStep]))
      .min(1)
      .max(20),
    outputs: z.record(name, name),
    folderId: z.string().nullable().default(null),
    limits: z
      .object({
        maxCalls: z.number().int().min(1).max(10).default(4),
        maxOutputTokens: z.number().int().min(64).max(4096).default(2048),
        maxInputBytes: z.number().int().min(100).max(100000).default(30000),
        maxRunSeconds: z.number().int().min(30).max(1800).default(600),
      })
      .default({
        maxCalls: 4,
        maxOutputTokens: 2048,
        maxInputBytes: 30000,
        maxRunSeconds: 600,
      }),
  })
  .strict();
export type Workflow = z.infer<typeof workflowSchema>;
