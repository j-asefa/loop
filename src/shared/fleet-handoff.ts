import { z } from "zod";
import {
  FleetDigest,
  FleetOrigin,
  FleetSignature,
  MachineIdentity,
  SignedFleetDirectory,
} from "./fleet.js";
import { FleetSecret } from "./fleet-credentials.js";

export const StartFleetHandoff = z
  .object({
    operationId: z.string().uuid(),
    expected: FleetDigest,
    destination: MachineIdentity,
  })
  .strict();
export type StartFleetHandoff = z.infer<typeof StartFleetHandoff>;
export const FleetHandoffJob = z
  .object({
    operationId: z.string().uuid(),
    destination: MachineIdentity,
    origin: FleetOrigin,
    directory: FleetDigest,
    state: z.enum(["ready", "uncertain", "complete", "superseded"]),
  })
  .strict();
export type FleetHandoffJob = z.infer<typeof FleetHandoffJob>;

export const FleetHandoffQuery = z
  .object({
    version: z.literal(1),
    nonce: FleetSecret,
    operationId: z.string().uuid(),
    expected: FleetDigest,
    directory: FleetDigest,
    controller: MachineIdentity,
    destination: MachineIdentity,
  })
  .strict();
export const SignedFleetHandoffQuery = z
  .object({ query: FleetHandoffQuery, signature: FleetSignature })
  .strict();
export type SignedFleetHandoffQuery = z.infer<typeof SignedFleetHandoffQuery>;
export const FleetHandoffReceipt = z
  .object({
    version: z.literal(1),
    queryDigest: FleetDigest,
    destination: MachineIdentity,
    // Missing is an observation at query time, not proof a delayed proposal
    // cannot arrive. It never authorizes replay or restores the old writer.
    state: z.enum(["missing", "complete"]),
    directory: SignedFleetDirectory.nullable(),
  })
  .strict()
  .refine((value) => (value.state === "complete") === !!value.directory);
export const SignedFleetHandoffReceipt = z
  .object({ receipt: FleetHandoffReceipt, signature: FleetSignature })
  .strict();
export type SignedFleetHandoffReceipt = z.infer<
  typeof SignedFleetHandoffReceipt
>;
