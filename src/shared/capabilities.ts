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
  pairedDevices: z.boolean(),
  /** Preview and fleet sources explicitly disable token management. */
  cardTokens: z.boolean(),
  personalDecisions: z.boolean(),
  personalApprovalDetails: z.boolean(),
  /** Gateway projection of this enrolled machine's verified catalog. */
  fleet: FleetSourceCapabilities.optional(),
});
export type Capabilities = z.infer<typeof Capabilities>;
export function workspaceCapabilities(): Capabilities {
  return {
    pairedDevices: true,
    cardTokens: true,
    personalDecisions: true,
    personalApprovalDetails: true,
  };
}
