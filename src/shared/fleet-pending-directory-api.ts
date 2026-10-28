import { z } from "zod";
import {
  SignedFleetPendingQuery,
  SignedFleetPendingHead,
  SignedFleetPendingPush,
  SignedFleetPendingAck,
} from "./fleet-pending-directory.js";
import type { RouteContract } from "./workspace-api.js";

const base = {
  method: "POST" as const,
  params: z.object({}).strict(),
  query: z.object({}).strict(),
  access: "peer:directory" as const,
};
export const fleetPendingDirectoryApi = {
  pendingDirectoryHead: {
    ...base,
    path: "/fleet/peer/v1/directory/pending-head",
    body: SignedFleetPendingQuery,
    response: SignedFleetPendingHead,
  },
  pendingDirectoryPush: {
    ...base,
    path: "/fleet/peer/v1/directory/pending-push",
    body: SignedFleetPendingPush,
    response: SignedFleetPendingAck,
  },
} as const satisfies Record<string, RouteContract>;
