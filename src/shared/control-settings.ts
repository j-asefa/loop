import { SessionSettingId } from "./contract-ids.js";
import { z } from "zod";

// Activity deltas are bounded and reject unknown fields. Full session catalogs
// preserve the harness's choices and strip unknown display fields.
export function settingSchema(limits?: {
  id: number;
  title: number;
  choices: number;
}) {
  const text = (maximum?: number) =>
    limits && maximum !== undefined ? z.string().max(maximum) : z.string();
  const value = z.union([text(1000), z.boolean(), z.number()]);
  const choice = z.object({
    value: text(1000),
    label: text(limits?.title),
    description: text(1000).optional(),
  });
  const choices = z.array(limits ? choice.strict() : choice);
  const setting = z.object({
    id: limits ? SessionSettingId.min(1).max(limits.id) : SessionSettingId,
    label: text(limits?.title).optional(),
    description: text(2000).nullable().optional(),
    type: z.enum(["select", "boolean", "text"]).optional(),
    choices: (limits ? choices.max(limits.choices) : choices)
      .nullable()
      .optional(),
    // Only the authoritative runtime confirms a value.
    confirmed: value.nullable().optional(),
    requested: value.nullable().optional(),
    rejected: text(1000).nullable().optional(),
    application: z.enum(["live", "next-turn", "new-session"]).optional(),
    mutable: z.boolean().optional(),
    reason: text(1000).nullable().optional(),
    provenance: text(100).optional(),
  });
  return limits ? setting.strict() : setting;
}
export const SessionSetting = settingSchema();
export type Setting = z.input<typeof SessionSetting>;
export type SettingValue = NonNullable<Setting["confirmed"]>;
