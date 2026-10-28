import { z } from "zod";
import type { FleetRouteContract } from "./workspace-api.js";
import {
  FleetEnrollmentProbe,
  FleetPrepareEnrollment,
  SignedFleetEnrollmentProbe,
  SignedFleetPreparedEnrollment,
  SignedFleetEnrollmentCommit,
  SignedFleetEnrollmentQuery,
  SignedFleetEnrollmentReceipt,
} from "./fleet-enrollment.js";

const base = {
  method: "POST" as const,
  params: z.object({}).strict(),
  query: z.object({}).strict(),
  access: "peer:enrollment" as const,
};
/** Dedicated proof/capability protocol. Browser sessions, Cards credentials and
 * cookie authentication are never alternatives to the required signed body.
 * The nonce probe reveals only proof of the already-confirmed machine key. */
export const fleetPeerApi = {
  enrollmentProbe: {
    ...base,
    path: "/fleet/peer/v1/enrollment/probe",
    body: FleetEnrollmentProbe,
    response: SignedFleetEnrollmentProbe,
  },
  enrollmentPrepare: {
    ...base,
    path: "/fleet/peer/v1/enrollment/prepare",
    body: FleetPrepareEnrollment,
    response: SignedFleetPreparedEnrollment,
  },
  enrollmentCommit: {
    ...base,
    path: "/fleet/peer/v1/enrollment/commit",
    body: SignedFleetEnrollmentCommit,
    response: SignedFleetEnrollmentReceipt,
  },
  enrollmentReceipt: {
    ...base,
    path: "/fleet/peer/v1/enrollment/receipt",
    body: SignedFleetEnrollmentQuery,
    response: SignedFleetEnrollmentReceipt,
  },
} as const satisfies Record<string, FleetRouteContract>;
