import { z } from "zod";
import type { RouteContract } from "./workspace-api.js";
import {
  SignedFleetDirectoryAck,
  SignedFleetDirectoryPush,
  SignedFleetHistoryPage,
  SignedFleetHistoryQuery,
} from "./fleet-directory-sync.js";

const base = {
  method: "POST" as const,
  params: z.object({}).strict(),
  query: z.object({}).strict(),
  access: "peer:directory" as const,
};
export const fleetDirectoryApi = {
  directoryHistory: {
    ...base,
    path: "/fleet/peer/v1/directory/history",
    body: SignedFleetHistoryQuery,
    response: SignedFleetHistoryPage,
  },
  directoryPush: {
    ...base,
    path: "/fleet/peer/v1/directory/push",
    body: SignedFleetDirectoryPush,
    response: SignedFleetDirectoryAck,
  },
} as const satisfies Record<string, RouteContract>;
