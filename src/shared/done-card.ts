import { z } from "zod";

const text = z.string().nullable();
const time = z.number().nonnegative();
// Session-only presentation data. Runtime actions still use the Feed contract.
export const DoneDisplaySchema = z.object({
  conversation_id: z.string(),
  done_card_key: text,
  title: z.string(),
  agent_id: text,
  connection_id: text,
  agent_name: text,
  provider: text,
  project_id: text,
  project_name: text,
  team_id: text,
  origin: z.string(),
  last_activity_at: time,
  last_message: z.object({
    id: z.string(), role: z.string(), preview: z.string(), content: z.string(),
    created_at: time, saved: z.boolean(),
    automation: z.string().optional(), automation_from: z.string().optional(),
  }).nullable(),
  run: z.object({
    id: z.string(), state: z.string(), error: text, input: z.string(),
    connection_id: text, model: text, resolved_model: text,
    created_at: time, updated_at: time, queue_position: z.number().nullable(),
    can_move_up: z.boolean(), can_move_down: z.boolean(),
    automation: z.string().optional(), automation_from: text.optional(),
    checkout: z.object({
      id: z.string(), state: z.enum(["started", "captured", "failed"]),
      scope: z.literal("run").optional(), branch: z.string(), base_ref: text,
      ahead: z.number().nullable(), behind: z.number().nullable(),
      files: z.number(), additions: z.number(), deletions: z.number(), untracked: z.number(),
      remote: z.enum(["none", "contains", "missing", "unknown"]),
      started_dirty: z.boolean(), overlap: z.number(), late: z.boolean(), error: text,
    }).optional(),
    verification: z.object({
      passed: z.number(), failed: z.number(), unknown: z.number(),
      items: z.array(z.object({ id: z.string(), kind: z.enum(["test", "typecheck", "lint"]),
        tools: z.array(z.string()), status: z.enum(["passed", "failed", "unknown"]) })),
    }).optional(),
  }).nullable(),
  pull: z.object({
    repo_owner: z.string(), repo_name: z.string(), number: z.number(),
    watch: z.enum(["watching", "paused", "stopped"]), ended_reason: text, error: text,
    head_sha: text, ci: z.object({sha: z.string(), conclusion: z.enum(["success", "failure"])}).nullable(),
    pending: z.boolean(), checked_at: time.nullable(),
  }).nullable(),
  position_message_id: text,
  later: z.object({id: z.string(), due_at: time.nullable(), condition: z.string(), surfaced_at: time.nullable()}).nullable(),
  next_action: z.object({kind: z.literal("result"), message_id: text, run_id: z.string()}).nullable(),
});
