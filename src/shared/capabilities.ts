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
  /** Absent on older sources; preview sources explicitly disable management. */
  cardTokens: z.boolean().optional(),
  /** Absent on sources that predate personal decision history. */
  personalDecisions: z.boolean().optional(),
  /** Absent on sources without full recorded approval details. */
  personalApprovalDetails: z.boolean().optional(),
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
