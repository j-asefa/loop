import { z } from "zod";
import { MachineId } from "./fleet.js";
import { FleetActionReceipt } from "./fleet-workspace-action-api.js";
import { FleetCommandReference } from "./fleet-command-api.js";
import type { FleetRouteContract } from "./workspace-api.js";

/** The local device checks an existing command, without its original body.
 * Only its enrolled destination may answer. This route never sends an action. */
export const fleetGatewayApi = {
  receipt: {
    method: "POST",
    path: "/fleet/commands/receipt",
    access: "device:fleet",
    params: z.strictObject({}),
    query: z.strictObject({}),
    body: FleetCommandReference.extend({
      peer: MachineId,
      commandId: z.string().uuid(),
    }),
    response: FleetActionReceipt,
  },
} as const satisfies Record<string, FleetRouteContract>;
