import {
  FleetEnrollmentProbe,
  FleetPrepareEnrollment,
  SignedFleetEnrollmentCommit,
  SignedFleetEnrollmentQuery,
} from "../shared/fleet-enrollment.js";
import { fleetPeerApi } from "../shared/fleet-peer-api.js";
import { Problem } from "../shared/problem.js";
import { FleetPeerHttpTransport } from "./fleet-peer-transport.js";
import type { FleetEnrollmentTransport } from "./fleet-enrollment-source.js";

export class FleetEnrollmentHttpTransport
  extends FleetPeerHttpTransport
  implements FleetEnrollmentTransport
{
  probe(origin: string, input: FleetEnrollmentProbe) {
    if (input.origin !== origin)
      return Promise.reject(new Problem(400, "The confirmed origin changed."));
    return this.exchange(origin, fleetPeerApi.enrollmentProbe, input);
  }
  prepare(origin: string, input: FleetPrepareEnrollment) {
    if (input.intent.origin !== origin)
      return Promise.reject(new Problem(400, "The confirmed origin changed."));
    return this.exchange(origin, fleetPeerApi.enrollmentPrepare, input);
  }
  commit(origin: string, input: SignedFleetEnrollmentCommit) {
    return this.exchange(origin, fleetPeerApi.enrollmentCommit, input);
  }
  receipt(origin: string, input: SignedFleetEnrollmentQuery) {
    return this.exchange(origin, fleetPeerApi.enrollmentReceipt, input);
  }
}
