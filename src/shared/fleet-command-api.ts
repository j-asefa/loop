import { z } from "zod";
import { FleetDigest } from "./fleet.js";
import { fleetActionRoutes } from "./fleet-workspace-action-api.js";
import { workspaceApi } from "./workspace-api.js";

/** Receipt references describe named effects, not transport bodies. Uploads
 * use files consent and their dedicated protocol, never the JSON action proxy. */
export const fleetCommandRoutes = {
  ...fleetActionRoutes,
  uploadCreate: workspaceApi.uploadCreate,
};
export const FleetCommandRoute = z.enum(
  Object.keys(fleetCommandRoutes) as [
    keyof typeof fleetCommandRoutes,
    ...(keyof typeof fleetCommandRoutes)[],
  ],
);
export const FleetCommandReference = z.strictObject({
  route: FleetCommandRoute,
  payloadDigest: FleetDigest,
});
export type FleetCommandReference = z.infer<typeof FleetCommandReference>;
