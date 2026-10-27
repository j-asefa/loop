import type { FleetHandoffProposal } from "../shared/fleet.js";
import { fleetHandoffApi } from "../shared/fleet-handoff-api.js";
import type { SignedFleetHandoffQuery } from "../shared/fleet-handoff.js";
import type { FleetHandoffTransport } from "./fleet-handoff.js";
import { FleetPeerHttpTransport } from "./fleet-peer-transport.js";

export class FleetHandoffHttpTransport
  extends FleetPeerHttpTransport
  implements FleetHandoffTransport
{
  commit(origin: string, proposal: FleetHandoffProposal) {
    return this.exchange(origin, fleetHandoffApi.handoffCommit, proposal);
  }
  receipt(origin: string, query: SignedFleetHandoffQuery) {
    return this.exchange(origin, fleetHandoffApi.handoffReceipt, query);
  }
}
