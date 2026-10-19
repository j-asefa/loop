import { z } from "zod";
import { DeploymentObservation } from "../../shared/build.js";

export const limits = {
  state: 5,
  decisions: 20,
  open_questions: 10,
  unfinished: 10,
} as const;
export const synthesisKinds = [
  "result",
  "prompt",
  "approval_resolved",
  "decision_resolved",
  "pr_update",
  "saved",
  "unsaved",
  "label",
  "mail",
  "brief_edit",
  "tombstone",
] as const;
export const Cite = z
  .object({
    ref: z
      .string()
      .regex(/^(?:(?:res|msg|saved|approval|chk|ver|dep)_.+|pr_\d+:c_.+)$/),
    quote: z.string().max(300).optional(),
  })
  .strict();
export type Cite = z.infer<typeof Cite>;
export const Evidence = z.enum([
  "owner_message",
  "owner_saved",
  "approval",
  "merge",
  "applied",
]);
export const Headline = z
  .object({
    text: z.string().max(140),
    update: z.string().max(160).optional(),
    cite: z.array(Cite),
  })
  .strict();
/** Reading layer; the full record and citations remain available on opening. */
export const ItemSummary = z
  .object({
    title: z.string().min(1).max(80),
    update: z.string().min(1).max(160).optional(),
    stage: z
      .enum([
        "in_progress",
        "needs_review",
        "on_main",
        "awaiting_update",
        "waiting",
        "done",
      ])
      .optional(),
    request: Cite.optional(),
  })
  .strict();
export type ItemSummary = z.infer<typeof ItemSummary>;
const common = {
  id: z.string().optional(),
  text: z.string().max(240),
  cite: z.array(Cite),
  summary: ItemSummary.optional(),
};
export const OutputItem = z.discriminatedUnion("kind", [
  z
    .object({
      ...common,
      kind: z.literal("state"),
      status: z.enum(["active", "retired"]).optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal("decision"),
      why: z.string().max(240).optional(),
      evidence: Evidence,
      decided_by: z.string(),
      status: z.enum(["active", "superseded", "reverted"]).optional(),
      supersedes: z.string().nullable().optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal("question"),
      asked_by: z.string(),
      status: z.enum(["open", "answered", "dropped"]).optional(),
      answered_cite: Cite.nullable().optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal("unfinished"),
      thread: z.string(),
      next: z.string().max(200),
      blocker: z.string().max(200).optional(),
      status: z.enum(["open", "done"]).optional(),
    })
    .strict(),
]);
export const Output = z
  .object({ headline: Headline, items: z.array(OutputItem) })
  .strict();
export type Output = z.infer<typeof Output>;
export const outputJsonSchema = z.toJSONSchema(Output);
export const Item = z
  .object({
    id: z.string(),
    kind: z.enum(["state", "decision", "question", "unfinished"]),
    text: z.string().max(240),
    summary: ItemSummary.optional(),
    why: z.string().max(240).optional(),
    status: z.string(),
    cite: z.array(Cite),
    cite_stale: z.boolean(),
    pinned: z.boolean(),
    author: z.enum(["model", "owner"]),
    evidence: Evidence.optional(),
    decided_by: z.string().optional(),
    decided_at: z.number().int().optional(),
    supersedes: z.string().nullable().optional(),
    asked_by: z.string().optional(),
    answered_cite: Cite.nullable().optional(),
    thread: z.string().optional(),
    next: z.string().max(200).optional(),
    blocker: z.string().max(200).optional(),
    first_version: z.number().int().nonnegative(),
    last_version: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((item, ctx) => {
    const statuses = {
      state: ["active", "retired"],
      decision: ["active", "superseded", "reverted"],
      question: ["open", "answered", "dropped"],
      unfinished: ["open", "done"],
    };
    if (!statuses[item.kind].includes(item.status))
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message: "Status does not match item kind",
      });
  });
export type Item = z.infer<typeof Item>;
export const Change = z
  .object({
    op: z.enum(["added", "changed", "resolved", "removed"]),
    field: z.string(),
    id: z.string(),
    since_version: z.number().int(),
    pinned: z.boolean(),
  })
  .strict();
export type Change = z.infer<typeof Change>;
export const Overflow = z
  .object({
    state: z.number().int().nonnegative(),
    decisions: z.number().int().nonnegative(),
    open_questions: z.number().int().nonnegative(),
    unfinished: z.number().int().nonnegative(),
  })
  .strict();
export const Brief = z
  .object({
    format: z.literal("loop.brief/v1"),
    project: z.string(),
    version: z.number().int().nonnegative(),
    basis: z
      .object({
        since: z.number().int(),
        through: z.number().int(),
        synth_at: z.number().int().nullable(),
        pending: z.number().int().nonnegative(),
        unincorporated_before: z.number().int().nullable(),
        window: z.string(),
      })
      .strict(),
    status: z.enum(["needs_you", "blocked", "working", "idle"]),
    goal: z
      .object({ text: z.string().max(200) })
      .strict()
      .nullable(),
    headline: Headline.nullable(),
    deployments: z.array(DeploymentObservation).max(10).optional(),
    state: z.array(Item).max(limits.state),
    decisions: z.array(Item).max(limits.decisions),
    open_questions: z.array(Item).max(limits.open_questions),
    unfinished: z.array(Item).max(limits.unfinished),
    needs_you: z.array(
      z
        .object({
          kind: z.enum([
            "approval",
            "question",
            "review",
            "failed",
            "not_sent",
          ]),
          ref: z.string(),
          conversation: z.string(),
        })
        .strict(),
    ),
    artifacts: z.array(
      z
        .object({
          kind: z.enum(["pr", "file", "chart"]),
          ref: z.string(),
          state: z.string(),
        })
        .strict(),
    ),
    changes: z.array(Change),
    overflow: Overflow,
    pins: z.array(z.string()),
    acknowledged_version: z.number().int().nonnegative(),
  })
  .strict();
export type Brief = z.infer<typeof Brief>;
export type ValidationError = {
  code:
    | "cite_unresolved"
    | "quote_not_contained"
    | "evidence_mismatch"
    | "decision_without_evidence"
    | "pinned_text_changed"
    | "unknown_id"
    | "bound_exceeded"
    | "derived_field"
    | "invalid_output";
  id: string;
  message: string;
};
