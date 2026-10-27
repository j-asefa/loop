import { z } from "zod";
import {
  FleetDigest,
  FleetSignature,
  MachineIdentity,
  SignedFleetDirectory,
} from "./fleet.js";
import { FleetSecret } from "./fleet-credentials.js";

const Exchange = z
  .object({
    version: z.literal(1),
    nonce: FleetSecret,
    sender: MachineIdentity,
    destination: MachineIdentity,
  })
  .strict();
export const FleetHistoryQuery = Exchange.extend({
  cursor: FleetDigest.nullable(),
}).strict();
export const SignedFleetHistoryQuery = z
  .object({ query: FleetHistoryQuery, signature: FleetSignature })
  .strict();
export type SignedFleetHistoryQuery = z.infer<typeof SignedFleetHistoryQuery>;
const State = z.enum(["controller", "replica", "handoff_pending", "removed"]);
export const FleetHistoryPage = z
  .object({
    version: z.literal(1),
    queryDigest: FleetDigest,
    destination: MachineIdentity,
    head: FleetDigest,
    // Newest first. A receiver verifies successors in reverse order only after
    // reaching a locally trusted anchor; a page is not a new trust anchor.
    entries: z.array(SignedFleetDirectory).min(1).max(32),
    next: FleetDigest.nullable(),
  })
  .strict();
export const SignedFleetHistoryPage = z
  .object({ page: FleetHistoryPage, signature: FleetSignature })
  .strict();
export type SignedFleetHistoryPage = z.infer<typeof SignedFleetHistoryPage>;
export const FleetDirectoryPush = Exchange.extend({
  anchor: FleetDigest,
  entries: z.array(SignedFleetDirectory).min(1).max(32),
}).strict();
export const SignedFleetDirectoryPush = z
  .object({ push: FleetDirectoryPush, signature: FleetSignature })
  .strict();
export type SignedFleetDirectoryPush = z.infer<typeof SignedFleetDirectoryPush>;
export const FleetDirectoryAck = z
  .object({
    version: z.literal(1),
    requestDigest: FleetDigest,
    destination: MachineIdentity,
    requested: FleetDigest,
    accepted: FleetDigest,
    head: FleetDigest,
    state: State,
  })
  .strict();
export const SignedFleetDirectoryAck = z
  .object({ ack: FleetDirectoryAck, signature: FleetSignature })
  .strict();
export type SignedFleetDirectoryAck = z.infer<typeof SignedFleetDirectoryAck>;
