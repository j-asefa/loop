import { z } from "zod";
import type { RouteContract } from "./workspace-api.js";
import {
  FleetAuthorityState,
  FleetCapabilities,
  FleetDigest,
  FleetOrigin,
  MachineId,
  MachineIdentity,
  FleetMember,
  SignedFleetDirectory,
} from "./fleet.js";
import {
  FleetEnrollmentJob,
  StartFleetEnrollment,
} from "./fleet-enrollment-source.js";
import { FleetHandoffJob, StartFleetHandoff } from "./fleet-handoff.js";

const empty = z.object({}).strict();
const base = {
  params: empty,
  query: empty,
  body: z.undefined(),
  access: "device:fleet" as const,
};
const mutation = z
  .object({
    mutationId: z.string().uuid(),
    expected: FleetDigest,
    confirm: z.literal(true),
  })
  .strict();
const initial = z
  .object({
    mutationId: z.string().uuid(),
    name: z.string().trim().min(1).max(80),
    scope: FleetCapabilities,
    confirm: z.literal(true),
  })
  .strict();
export const FleetAdminState = z
  .object({
    identity: MachineIdentity,
    origin: FleetOrigin,
    state: FleetAuthorityState,
    head: FleetDigest.nullable(),
    directory: SignedFleetDirectory.nullable(),
    scope: FleetCapabilities,
    pendingDistribution: z.number().int().min(0),
    unconfirmed: z.array(FleetMember).max(127),
  })
  .strict();
export const FleetOperationCursor = z
  .object({
    createdAt: z.number().int().min(0),
    operationId: z.string().uuid(),
  })
  .strict();
export const FleetEnrollmentPage = z
  .object({
    items: z.array(FleetEnrollmentJob).max(50),
    next: FleetOperationCursor.nullable(),
  })
  .strict();
export const FleetHandoffPage = z
  .object({
    items: z.array(FleetHandoffJob).max(50),
    next: FleetOperationCursor.nullable(),
  })
  .strict();
export const FleetPendingConsent = z
  .object({
    operationId: z.string().uuid(),
    controller: MachineIdentity,
    fleetId: z.string().uuid(),
    mode: z.enum(["enroll", "repair", "recover"]),
    scope: FleetCapabilities,
  })
  .strict();
export const FleetPendingPage = z
  .object({
    items: z.array(FleetPendingConsent).max(50),
    next: z.string().uuid().nullable(),
  })
  .strict();
const page = z.object({ cursor: FleetOperationCursor.nullable() }).strict();
const operation = z.object({ operationId: z.string().uuid() }).strict();
const done = z.object({ ok: z.literal(true) }).strict();

/** These routes are mounted only behind the companion's local device boundary.
 * There is no peer credential, Cards token or server-owner alternative. */
export const fleetAdminApi = {
  state: {
    ...base,
    method: "GET",
    path: "/fleet/admin/state",
    response: FleetAdminState,
  },
  create: {
    ...base,
    method: "POST",
    path: "/fleet/admin/create",
    body: initial,
    response: FleetAdminState,
  },
  recover: {
    ...base,
    method: "POST",
    path: "/fleet/admin/recover",
    body: initial.extend({ expected: FleetDigest }).strict(),
    response: FleetAdminState,
  },
  remove: {
    ...base,
    method: "POST",
    path: "/fleet/admin/remove",
    body: mutation.extend({ machineId: MachineId }).strict(),
    response: FleetAdminState,
  },
  repairSelf: {
    ...base,
    method: "POST",
    path: "/fleet/admin/repair-self",
    body: mutation,
    response: FleetAdminState,
  },
  mint: {
    ...base,
    method: "POST",
    path: "/fleet/admin/enrollment-link",
    body: z
      .object({
        scope: FleetCapabilities,
        recover: z.boolean(),
        confirm: z.literal(true),
      })
      .strict(),
    response: z.object({ url: z.string().max(8192) }).strict(),
  },
  begin: {
    ...base,
    method: "POST",
    path: "/fleet/admin/enrollment/begin",
    body: StartFleetEnrollment.extend({ confirm: z.literal(true) }).strict(),
    response: FleetEnrollmentJob,
  },
  advance: {
    ...base,
    method: "POST",
    path: "/fleet/admin/enrollment/advance",
    body: operation,
    response: FleetEnrollmentJob,
  },
  reconcile: {
    ...base,
    method: "POST",
    path: "/fleet/admin/enrollment/reconcile",
    body: operation,
    response: FleetEnrollmentJob,
  },
  cancel: {
    ...base,
    method: "POST",
    path: "/fleet/admin/enrollment/cancel",
    body: operation,
    response: FleetEnrollmentJob,
  },
  list: {
    ...base,
    method: "POST",
    path: "/fleet/admin/enrollment/list",
    body: page,
    response: FleetEnrollmentPage,
  },
  pending: {
    ...base,
    method: "POST",
    path: "/fleet/admin/pending",
    body: z.object({ cursor: z.string().uuid().nullable() }).strict(),
    response: FleetPendingPage,
  },
  cancelPending: {
    ...base,
    method: "POST",
    path: "/fleet/admin/pending/cancel",
    body: operation,
    response: done,
  },
  handoffBegin: {
    ...base,
    method: "POST",
    path: "/fleet/admin/handoff/begin",
    body: StartFleetHandoff.extend({ confirm: z.literal(true) }).strict(),
    response: FleetHandoffJob,
  },
  handoffAdvance: {
    ...base,
    method: "POST",
    path: "/fleet/admin/handoff/advance",
    body: operation,
    response: FleetHandoffJob,
  },
  handoffReconcile: {
    ...base,
    method: "POST",
    path: "/fleet/admin/handoff/reconcile",
    body: operation
      .extend({ origin: FleetOrigin.optional(), confirm: z.literal(true) })
      .strict(),
    response: FleetHandoffJob,
  },
  handoffList: {
    ...base,
    method: "POST",
    path: "/fleet/admin/handoff/list",
    body: page,
    response: FleetHandoffPage,
  },
} as const satisfies Record<string, RouteContract>;
