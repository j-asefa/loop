import { z } from "zod";
import {
  FleetDigest,
  FleetSignature,
  MachineIdentity,
  SignedFleetDirectory,
} from "./fleet.js";
import { FleetSecret } from "./fleet-credentials.js";
import { FleetAdmission } from "./fleet-directory-sync.js";

const Exchange = z
  .object({
    version: z.literal(1),
    nonce: FleetSecret,
    sender: MachineIdentity,
    destination: MachineIdentity,
    grantId: z.string().uuid(),
  })
  .strict();
const State = z.enum(["prepared", "cancelled", "complete"]);
export const SignedFleetPendingQuery = z
  .object({
    query: Exchange.extend({
      // Only these canonically published operations may be discovered. A newly
      // prepared ceremony reusing the grant is not implicitly selected.
      operationIds: z.array(z.string().uuid()).min(1).max(1024),
      admission: FleetAdmission.optional(),
    }).strict(),
    signature: FleetSignature,
  })
  .strict();
export type SignedFleetPendingQuery = z.infer<typeof SignedFleetPendingQuery>;
export const SignedFleetPendingHead = z
  .object({
    head: z
      .object({
        version: z.literal(1),
        queryDigest: FleetDigest,
        destination: MachineIdentity,
        grantId: z.string().uuid(),
        operationId: z.string().uuid(),
        state: State,
        directory: SignedFleetDirectory,
      })
      .strict(),
    signature: FleetSignature,
  })
  .strict();
export type SignedFleetPendingHead = z.infer<typeof SignedFleetPendingHead>;
export const SignedFleetPendingPush = z
  .object({
    push: Exchange.extend({
      operationId: z.string().uuid(),
      anchor: FleetDigest,
      entries: z.array(SignedFleetDirectory).min(1).max(32),
    }).strict(),
    signature: FleetSignature,
  })
  .strict();
export type SignedFleetPendingPush = z.infer<typeof SignedFleetPendingPush>;
export const SignedFleetPendingAck = z
  .object({
    ack: z
      .object({
        version: z.literal(1),
        requestDigest: FleetDigest,
        destination: MachineIdentity,
        grantId: z.string().uuid(),
        operationId: z.string().uuid(),
        state: State,
        requested: FleetDigest,
        accepted: FleetDigest,
      })
      .strict(),
    signature: FleetSignature,
  })
  .strict();
export type SignedFleetPendingAck = z.infer<typeof SignedFleetPendingAck>;
