import { fleetDirectoryApi } from "../shared/fleet-directory-api.js";
import type {
  SignedFleetDirectoryPush,
  SignedFleetHistoryQuery,
} from "../shared/fleet-directory-sync.js";
import { FleetPeerHttpTransport } from "./fleet-peer-transport.js";

export class FleetDirectoryHttpTransport extends FleetPeerHttpTransport {
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
