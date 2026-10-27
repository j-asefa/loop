import { z } from "zod";
import { FleetHandoffProposal, SignedFleetDirectory } from "./fleet.js";
import {
  SignedFleetHandoffQuery,
  SignedFleetHandoffReceipt,
} from "./fleet-handoff.js";
import type { RouteContract } from "./workspace-api.js";

const base = {
  method: "POST" as const,
  params: z.object({}).strict(),
  query: z.object({}).strict(),
  access: "peer:handoff" as const,
};
export const fleetHandoffApi = {
  handoffCommit: {
    ...base,
    path: "/fleet/peer/v1/handoff/commit",
    body: FleetHandoffProposal,
    response: SignedFleetDirectory,
  },
  handoffReceipt: {
    ...base,
    path: "/fleet/peer/v1/handoff/receipt",
    body: SignedFleetHandoffQuery,
    response: SignedFleetHandoffReceipt,
  },
} as const satisfies Record<string, RouteContract>;
