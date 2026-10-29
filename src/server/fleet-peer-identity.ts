import { randomBytes } from "node:crypto";
import type { FleetMember } from "../shared/fleet.js";
import {
  SignedFleetEnrollmentProbe,
  type FleetEnrollmentProbe,
} from "../shared/fleet-enrollment.js";
import { Problem } from "../shared/problem.js";
import { fleetPayloadDigest } from "./fleet-crypto.js";
import { verifyFleetProof } from "./fleet-proof.js";

export interface FleetIdentityTransport {
  probe(
    origin: string,
    input: FleetEnrollmentProbe,
    signal: AbortSignal,
  ): Promise<unknown>;
}
/** Verify the enrolled machine before sending credentials or workspace content
 * to an origin that may have been reassigned since the last lease acquisition. */
export async function verifyFleetDestination(
  member: FleetMember,
  transport: FleetIdentityTransport,
  signal: AbortSignal,
) {
  const probe: FleetEnrollmentProbe = {
    version: 1,
    origin: member.origin,
    nonce: randomBytes(32).toString("base64url"),
    destination: { machineId: member.machineId, publicKey: member.publicKey },
  };
  const response = SignedFleetEnrollmentProbe.safeParse(
    await transport.probe(member.origin, probe, signal),
  );
  if (
    !response.success ||
    fleetPayloadDigest(response.data.probe) !== fleetPayloadDigest(probe) ||
    !verifyFleetProof(
      probe.destination,
      "enrollment-probe",
      response.data.probe,
      response.data.signature,
    )
  )
    throw new Problem(
      403,
      "The fleet destination identity could not be verified.",
    );
}
