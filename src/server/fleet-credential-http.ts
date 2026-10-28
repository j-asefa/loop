import type { FleetGrantContext } from "../shared/fleet.js";
import type { FleetCredentialProof } from "../shared/fleet-credentials.js";
import { fleetCredentialApi } from "../shared/fleet-credential-api.js";
import { FleetPeerHttpTransport } from "./fleet-peer-transport.js";
import type { FleetCredentialTransport } from "./fleet-credential-lease.js";

export class FleetCredentialHttpTransport
  extends FleetPeerHttpTransport
  implements FleetCredentialTransport
{
  challenge(origin: string, context: FleetGrantContext, signal: AbortSignal) {
    return this.exchange(
      origin,
      fleetCredentialApi.credentialChallenge,
      context,
      signal,
    );
  }
  issue(origin: string, proof: FleetCredentialProof, signal: AbortSignal) {
    return this.exchange(
      origin,
      fleetCredentialApi.credentialIssue,
      proof,
      signal,
    );
  }
}
