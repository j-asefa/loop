import { z } from "zod";
import { FleetGrantContext } from "./fleet.js";
import {
  FleetCredentialProof,
  SignedFleetChallenge,
  SignedFleetCredential,
} from "./fleet-credentials.js";
import type { RouteContract } from "./workspace-api.js";

const base = {
  method: "POST" as const,
  params: z.object({}).strict(),
  query: z.object({}).strict(),
  access: "peer:credentials" as const,
};
export const fleetCredentialApi = {
  credentialChallenge: {
    ...base,
    path: "/fleet/peer/v1/credentials/challenge",
    body: FleetGrantContext,
    response: SignedFleetChallenge,
  },
  credentialIssue: {
    ...base,
    path: "/fleet/peer/v1/credentials/issue",
    body: FleetCredentialProof,
    response: SignedFleetCredential,
  },
} as const satisfies Record<string, RouteContract>;
