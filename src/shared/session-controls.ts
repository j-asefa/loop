import { NativeGenerationId } from "./contract-ids.js";
import { z } from "zod";
import { SessionSetting } from "./control-settings.js";
import { ActivityCapabilities } from "./agent-activities.js";
export { ActivityCapabilities as SessionCapabilities } from "./agent-activities.js";

export const SessionControls = z.strictObject({
  generation: NativeGenerationId.nullable(),
  state: z.string().optional(),
  settings: z.strictObject({
    options: z.array(SessionSetting),
    revision: z.number().int().nonnegative(),
  }),
  commands: z.strictObject({
    commands: z.array(z.record(z.string(), z.json())),
    revision: z.number().int().nonnegative(),
  }),
  capabilities: ActivityCapabilities,
});
export type SessionControls = z.input<typeof SessionControls>;
