import { z } from "zod";
import { ACTIVITY_FEATURES, type Setting } from "./agent-activities.js";

const Value = z.union([z.string(), z.boolean(), z.number()]);
// Public session controls include the full catalog, unlike bounded activity deltas.
const SessionSetting = z.object({
  id: z.string(),
  label: z.string().optional(),
  description: z.string().nullable().optional(),
  type: z.enum(["select", "boolean", "text"]).optional(),
  choices: z
    .array(
      z.object({
        value: z.string(),
        label: z.string(),
        description: z.string().optional(),
      }),
    )
    .nullable()
    .optional(),
  confirmed: Value.nullable().optional(),
  requested: Value.nullable().optional(),
  rejected: z.string().nullable().optional(),
  application: z.enum(["live", "next-turn", "new-session"]).optional(),
  mutable: z.boolean().optional(),
  reason: z.string().nullable().optional(),
  provenance: z.string().optional(),
}) satisfies z.ZodType<Setting>;
export const SessionCapabilities = z.record(
  z.enum(ACTIVITY_FEATURES),
  z.strictObject({
    state: z.enum(["supported", "unsupported", "undiscovered"]),
    source: z.string(),
    reason: z.string().optional(),
  }),
);
export const SessionControls = z.strictObject({
  generation: z.string().nullable(),
  state: z.string().optional(),
  settings: z.strictObject({
    options: z.array(SessionSetting),
    revision: z.number().int().nonnegative(),
  }),
  commands: z.strictObject({
    commands: z.array(z.record(z.string(), z.json())),
    revision: z.number().int().nonnegative(),
  }),
  capabilities: SessionCapabilities,
});
export type SessionControls = z.infer<typeof SessionControls>;
