import { z } from "zod";
import {
  FleetCapabilities,
  FleetDigest,
  FleetMember,
  FleetOrigin,
  FleetSignature,
  MachineIdentity,
  SignedFleetDirectory,
} from "./fleet.js";
import { FleetSecret } from "./fleet-credentials.js";

const Id = z.string().uuid();
export const FleetEnrollmentProbe = z
  .object({
    version: z.literal(1),
    nonce: FleetSecret,
    origin: FleetOrigin,
    destination: MachineIdentity,
  })
  .strict();
export type FleetEnrollmentProbe = z.infer<typeof FleetEnrollmentProbe>;
export const SignedFleetEnrollmentProbe = z
  .object({ probe: FleetEnrollmentProbe, signature: FleetSignature })
  .strict();
export type SignedFleetEnrollmentProbe = z.infer<
  typeof SignedFleetEnrollmentProbe
>;
export const FleetEnrollmentMode = z.enum(["enroll", "repair", "recover"]);
export const FleetEnrollmentIntent = z
  .object({
    version: z.literal(1),
    operationId: Id,
    ceremonyId: Id,
    capabilityHash: FleetDigest,
    destination: MachineIdentity,
    origin: FleetOrigin,
    name: FleetMember.shape.name,
    mode: FleetEnrollmentMode,
    scope: FleetCapabilities,
    directory: SignedFleetDirectory,
  })
  .strict();
export type FleetEnrollmentIntent = z.infer<typeof FleetEnrollmentIntent>;
export const FleetPrepareEnrollment = z
  .object({
    intent: FleetEnrollmentIntent,
    signature: FleetSignature,
    capability: FleetSecret,
  })
  .strict();
export type FleetPrepareEnrollment = z.infer<typeof FleetPrepareEnrollment>;
export const FleetPreparedEnrollment = z
  .object({
    version: z.literal(1),
    operationId: Id,
    intentDigest: FleetDigest,
    member: FleetMember,
    expectedHead: FleetDigest.nullable(),
    mode: FleetEnrollmentMode,
    scope: FleetCapabilities,
  })
  .strict();
export type FleetPreparedEnrollment = z.infer<typeof FleetPreparedEnrollment>;
export const SignedFleetPreparedEnrollment = z
  .object({
    prepared: FleetPreparedEnrollment,
    signature: FleetSignature,
  })
  .strict();
export type SignedFleetPreparedEnrollment = z.infer<
  typeof SignedFleetPreparedEnrollment
>;
export const FleetEnrollmentCommit = z
  .object({
    version: z.literal(1),
    operationId: Id,
    intentDigest: FleetDigest,
    directory: SignedFleetDirectory,
    // Repair can bring a stale destination through already signed successors.
    ancestors: z.array(SignedFleetDirectory).max(64),
  })
  .strict();
export type FleetEnrollmentCommit = z.infer<typeof FleetEnrollmentCommit>;
export const SignedFleetEnrollmentCommit = z
  .object({
    commit: FleetEnrollmentCommit,
    signature: FleetSignature,
  })
  .strict();
export type SignedFleetEnrollmentCommit = z.infer<
  typeof SignedFleetEnrollmentCommit
>;
export const FleetEnrollmentReceipt = z
  .object({
    version: z.literal(1),
    operationId: Id,
    intentDigest: FleetDigest,
    destination: MachineIdentity,
    state: z.enum(["prepared", "complete", "cancelled"]),
    prepared: SignedFleetPreparedEnrollment,
    directory: FleetDigest.nullable(),
  })
  .strict();
export const SignedFleetEnrollmentReceipt = z
  .object({
    receipt: FleetEnrollmentReceipt,
    signature: FleetSignature,
  })
  .strict();
export type SignedFleetEnrollmentReceipt = z.infer<
  typeof SignedFleetEnrollmentReceipt
>;
export const FleetEnrollmentQuery = z
  .object({
    version: z.literal(1),
    operationId: Id,
    intentDigest: FleetDigest,
    destination: MachineIdentity,
  })
  .strict();
export const SignedFleetEnrollmentQuery = z
  .object({
    query: FleetEnrollmentQuery,
    signature: FleetSignature,
  })
  .strict();
export type SignedFleetEnrollmentQuery = z.infer<
  typeof SignedFleetEnrollmentQuery
>;
