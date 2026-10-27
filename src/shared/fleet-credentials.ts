import { z } from "zod";
import { FleetGrantContext, FleetSignature } from "./fleet.js";

export const FLEET_CREDENTIAL_LIFETIME_MS = 10 * 60_000;
export const FLEET_RENEW_BEFORE_MS = 2 * 60_000;
export const FLEET_NONCE_LIFETIME_MS = 60_000;
// Canonical unpadded base64url encoding of 32 random bytes.
export const FleetSecret = z
  .string()
  .regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
const Time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const FleetChallenge = z
  .object({
    version: z.literal(1),
    context: FleetGrantContext,
    nonce: FleetSecret,
    issuerSession: z.string().uuid(),
    expiresAtMonotonic: Time,
    issuedAt: Time,
    expiresAt: Time,
  })
  .strict();
export const SignedFleetChallenge = z
  .object({
    challenge: FleetChallenge,
    signature: FleetSignature,
  })
  .strict();
export type SignedFleetChallenge = z.infer<typeof SignedFleetChallenge>;
export const FleetCredentialRequest = z
  .object({
    challenge: SignedFleetChallenge,
    requestNonce: FleetSecret,
  })
  .strict();
export const FleetCredentialProof = FleetCredentialRequest.extend({
  signature: FleetSignature,
}).strict();
export type FleetCredentialProof = z.infer<typeof FleetCredentialProof>;
export const FleetCredential = z
  .object({
    version: z.literal(1),
    context: FleetGrantContext,
    nonce: FleetSecret,
    requestNonce: FleetSecret,
    token: FleetSecret,
    remainingMs: z.number().int().positive().max(FLEET_CREDENTIAL_LIFETIME_MS),
  })
  .strict();
export const SignedFleetCredential = z
  .object({
    credential: FleetCredential,
    signature: FleetSignature,
  })
  .strict();
export type SignedFleetCredential = z.infer<typeof SignedFleetCredential>;

/** Called with local monotonic elapsed time, never a peer's wall clock. Subtract
 * the entire request round trip so delayed responses cannot extend a lifetime. */
export function fleetCredentialTiming(
  remainingMs: number,
  roundTripMs: number,
  jitterMs = 0,
) {
  if (
    !Number.isFinite(remainingMs) ||
    remainingMs < 0 ||
    !Number.isFinite(roundTripMs) ||
    roundTripMs < 0 ||
    !Number.isFinite(jitterMs)
  )
    throw new Error("Invalid fleet credential timing.");
  const remaining = Math.max(
    0,
    Math.min(FLEET_CREDENTIAL_LIFETIME_MS, remainingMs) -
      Math.ceil(roundTripMs),
  );
  return {
    remainingMs: remaining,
    renewInMs: Math.max(
      0,
      remaining -
        FLEET_RENEW_BEFORE_MS -
        Math.max(0, Math.min(15_000, jitterMs)),
    ),
  };
}
