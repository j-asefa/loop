import { fleetDirectoryApi } from "../shared/fleet-directory-api.js";
import type {
  SignedFleetDirectoryPush,
  SignedFleetHistoryQuery,
} from "../shared/fleet-directory-sync.js";
import { FleetPeerHttpTransport } from "./fleet-peer-transport.js";
import type { FleetEnrollmentProbe } from "../shared/fleet-enrollment.js";
import { fleetPeerApi } from "../shared/fleet-peer-api.js";
import { fleetPendingDirectoryApi } from "../shared/fleet-pending-directory-api.js";
import type {
  SignedFleetPendingQuery,
  SignedFleetPendingPush,
} from "../shared/fleet-pending-directory.js";

export class FleetDirectoryHttpTransport extends FleetPeerHttpTransport {
  probe(origin: string, input: FleetEnrollmentProbe, signal?: AbortSignal) {
    return this.exchange(origin, fleetPeerApi.enrollmentProbe, input, signal);
  }
  pendingHistory(
    origin: string,
    input: SignedFleetPendingQuery,
    signal?: AbortSignal,
  ) {
    return this.exchange(
      origin,
      fleetPendingDirectoryApi.pendingDirectoryHead,
      input,
      signal,
    );
  }
  pendingPush(
    origin: string,
    input: SignedFleetPendingPush,
    signal?: AbortSignal,
  ) {
    return this.exchange(
      origin,
      fleetPendingDirectoryApi.pendingDirectoryPush,
      input,
      signal,
    );
  }
  history(
    origin: string,
    input: SignedFleetHistoryQuery,
    signal?: AbortSignal,
  ) {
    return this.exchange(
      origin,
      fleetDirectoryApi.directoryHistory,
      input,
      signal,
    );
  }
  push(origin: string, input: SignedFleetDirectoryPush, signal?: AbortSignal) {
    return this.exchange(
      origin,
      fleetDirectoryApi.directoryPush,
      input,
      signal,
    );
  }
}
