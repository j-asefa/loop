import { z } from "zod";
import { MachineId } from "./fleet.js";
export const FleetSourceCapabilities = z.strictObject({
  version: z.literal(1),
  machineId: MachineId,
  reads: z.array(z.string().max(100)).max(100),
  actions: z.array(z.string().max(100)).max(100),
  files: z.boolean(),
  events: z.boolean(),
});
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
  /** Gateway projection of this enrolled machine's verified catalog. */
  fleet: FleetSourceCapabilities.optional(),
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
