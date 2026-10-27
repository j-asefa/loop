import { z } from "zod";
import {
  FleetCapabilities,
  FleetDigest,
  FleetMember,
  MachineIdentity,
} from "./fleet.js";
import { FleetEnrollmentMode } from "./fleet-enrollment.js";
import { FleetEnrollmentLink } from "./fleet-pairing.js";

/** The browser must project a scanned link before calling local administration.
 * This strict input cannot carry the destination's device capability. */
export const StartFleetEnrollment = z
  .object({
    operationId: z.string().uuid(),
    expected: FleetDigest,
    link: FleetEnrollmentLink,
    name: FleetMember.shape.name,
    mode: FleetEnrollmentMode,
    scope: FleetCapabilities,
  })
  .strict();
export type StartFleetEnrollment = z.infer<typeof StartFleetEnrollment>;
export const FleetEnrollmentJob = z
  .object({
    operationId: z.string().uuid(),
    destination: MachineIdentity,
    name: FleetMember.shape.name,
    origin: FleetMember.shape.origin,
    mode: FleetEnrollmentMode,
    state: z.enum([
      "ready",
      "preparing",
      "uncertain",
      "prepared",
      "published",
      "complete",
      "cancelled",
    ]),
    phase: z.enum(["prepare", "commit"]),
    directory: FleetDigest.nullable(),
    remoteState: z.enum(["prepared", "complete", "cancelled"]).nullable(),
  })
  .strict();
export type FleetEnrollmentJob = z.infer<typeof FleetEnrollmentJob>;
