import { z } from "zod";
export const Capabilities = z.object({
  profile: z.enum(["server", "companion"]),
  nativeHarnesses: z.boolean(),
  pairedDevices: z.boolean(),
  runtimeHosts: z.boolean(),
  localProjects: z.boolean(),
  /** Absent on older sources; preview sources explicitly disable management. */
  cardTokens: z.boolean().optional(),
  /** Absent on sources that predate personal decision history. */
  personalDecisions: z.boolean().optional(),
  /** Absent on sources without full recorded approval details. */
  personalApprovalDetails: z.boolean().optional(),
  /** Absent on sources without the idempotent continuation-start endpoint. */
  continuationStart: z.boolean().optional(),
});
export type Capabilities = z.infer<typeof Capabilities>;
export type DeploymentProfile = Capabilities["profile"];
export function profileCapabilities(profile: DeploymentProfile): Capabilities {
  const companion = profile === "companion";
  return {
    profile,
    nativeHarnesses: companion,
    pairedDevices: companion,
    runtimeHosts: !companion,
    localProjects: companion,
    cardTokens: true,
    personalDecisions: true,
    personalApprovalDetails: true,
    continuationStart: true,
  };
}
