import type Database from "better-sqlite3";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { FleetSignature, MachineIdentity } from "../shared/fleet.js";
import { Problem } from "../shared/problem.js";
import {
  fleetPayloadDigest,
  identityFromPrivateKey,
  machineIdentity,
} from "./fleet-crypto.js";
import type { initializeFleetIdentity } from "./fleet-identity.js";

type Purpose =
  | "enrollment-probe"
  | "enrollment-prepare"
  | "enrollment-prepared"
  | "enrollment-commit"
  | "enrollment-query"
  | "enrollment-receipt"
  | "directory-sync"
  | "directory-ack";
function bytes(purpose: Purpose, parsed: unknown) {
  return Buffer.from(`loop:fleet:${purpose}:v1\n${fleetPayloadDigest(parsed)}`);
}
/** Only strict, bounded protocol schemas may supply the parsed input. */
export function verifyFleetProof(
  identity: MachineIdentity,
  purpose: Purpose,
  parsed: unknown,
  signature: string,
) {
  try {
    const expected = MachineIdentity.parse(identity);
    if (machineIdentity(expected.publicKey).machineId !== expected.machineId)
      return false;
    return verify(
      null,
      bytes(purpose, parsed),
      createPublicKey({
        key: Buffer.from(expected.publicKey, "base64url"),
        format: "der",
        type: "spki",
      }),
      Buffer.from(FleetSignature.parse(signature), "base64url"),
    );
  } catch {
    return false;
  }
}
export class FleetProof {
  constructor(
    private readonly db: Database.Database,
    private readonly identity: MachineIdentity,
    private readonly secrets: Parameters<typeof initializeFleetIdentity>[1],
  ) {}
  sign(purpose: Purpose, parsed: unknown) {
    const row = this.db
      .prepare(
        "SELECT private_key FROM fleet_machine_identity WHERE singleton=1",
      )
      .get() as { private_key: string };
    const key = this.secrets.unseal(
      row.private_key,
      `fleet:machine:${this.identity.machineId}`,
    );
    if (identityFromPrivateKey(key).machineId !== this.identity.machineId)
      throw new Problem(409, "The local fleet signing key is unavailable.");
    return sign(
      null,
      bytes(purpose, parsed),
      createPrivateKey({
        key: Buffer.from(key, "base64url"),
        format: "der",
        type: "pkcs8",
      }),
    ).toString("base64url");
  }
}
