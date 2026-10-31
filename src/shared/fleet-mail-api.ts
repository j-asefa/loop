import { z } from "zod";
import { FleetDigest, FleetSignature, MachineId } from "./fleet.js";
import { FleetSecret } from "./fleet-credentials.js";
import {
  FleetMailEnvelope,
  FleetMailOffer,
  FleetMailReceipt,
  FleetMailReference,
} from "./fleet-mail.js";
import type { FleetRouteContract } from "./workspace-api.js";
import { FleetMailFileChunk } from "./fleet-mail-files.js";
import { MAX_UPLOAD_BYTES } from "./uploads.js";

export const FleetAgentQuery = z.strictObject({
  query: z.string().trim().max(200).optional(),
  offset: z.number().int().min(0).max(100000).default(0),
  limit: z.number().int().min(1).max(50).default(20),
});
export type FleetAgentQuery = z.infer<typeof FleetAgentQuery>;
export const FleetDirectoryAgent = z.strictObject({
  agentId: z.string().uuid(),
  name: z.string().min(1).max(200),
  runtime: z.string().min(1).max(200),
  availability: z.enum(["available", "busy", "disconnected", "unavailable"]),
  reason: z.string().max(500).optional(),
});
export const FleetAgentPage = z
  .strictObject({
    agents: z.array(FleetDirectoryAgent).max(50),
    nextOffset: z.number().int().min(0).max(100000).nullable(),
  })
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).length <= 128 * 1024,
  );
export type FleetAgentPage = z.infer<typeof FleetAgentPage>;

const Admission = z.strictObject({
  version: z.literal(1),
  requestId: z.string().uuid(),
  credential: FleetSecret,
});
const identity = {
  version: z.literal(1),
  requestId: z.string().uuid(),
  requestDigest: FleetDigest,
  machineId: MachineId,
  peer: MachineId,
  grantId: z.string().uuid(),
  directory: FleetDigest,
};
export const FleetMailDirectoryResponse = z.strictObject({
  ...identity,
  page: FleetAgentPage,
});
export const FleetMailDeliveryResponse = z.strictObject({
  ...identity,
  method: z.enum(["prepare", "accept", "receipt"]),
  receipt: FleetMailReceipt.nullable(),
});
export const FleetMailFileResponse = z.strictObject({
  ...identity,
  nextOffset: z.number().int().min(0).max(MAX_UPLOAD_BYTES).nullable(),
});
const signed = <S extends z.ZodType>(response: S) =>
  z.strictObject({ response, signature: FleetSignature });
const base = {
  method: "POST" as const,
  access: "peer:workspace" as const,
  params: z.strictObject({}),
  query: z.strictObject({}),
};
export const fleetMailApi = {
  directory: {
    ...base,
    path: "/fleet/peer/v1/mail/directory",
    body: Admission.extend({ query: FleetAgentQuery }),
    response: signed(FleetMailDirectoryResponse),
  },
  prepare: {
    ...base,
    path: "/fleet/peer/v1/mail/prepare",
    body: Admission.extend({ offer: FleetMailOffer }),
    response: signed(FleetMailDeliveryResponse),
  },
  accept: {
    ...base,
    path: "/fleet/peer/v1/mail/accept",
    body: Admission.extend({
      envelope: FleetMailEnvelope,
      reservationId: z.string().uuid(),
    }),
    response: signed(FleetMailDeliveryResponse),
  },
  file: {
    ...base,
    path: "/fleet/peer/v1/mail/file",
    body: Admission.extend(FleetMailFileChunk.shape),
    response: signed(FleetMailFileResponse),
  },
  receipt: {
    ...base,
    path: "/fleet/peer/v1/mail/receipt",
    body: Admission.extend({ reference: FleetMailReference }),
    response: signed(FleetMailDeliveryResponse),
  },
} as const satisfies Record<string, FleetRouteContract>;
