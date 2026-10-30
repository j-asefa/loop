import { z } from "zod";
import { FleetDigest, FleetSignature, MachineId } from "./fleet.js";
import { FleetSecret } from "./fleet-credentials.js";
import { UploadOptions } from "./library-contract-schemas.js";
import { FleetActionReceipt } from "./fleet-workspace-action-api.js";
import {
  FLEET_FILE_BYTES,
  FLEET_FILE_CHUNK_BYTES,
} from "./fleet-workspace-file-api.js";
import type { FleetRouteContract } from "./workspace-api.js";

/** The same canonical upload identity is retained by browser, gateway and
 * destination. File content is identified by its size and SHA-256, never by a
 * temporary transfer ID, multipart boundary or local path. */
export const FleetUploadInput = z.strictObject({
  route: z.literal("uploadCreate"),
  params: z.strictObject({}),
  body: z.strictObject({
    options: UploadOptions.strict(),
    file: z.strictObject({
      name: z.string().min(1).max(1024),
      mime: z
        .string()
        .min(1)
        .max(150)
        .regex(/^[\x20-\x7e]+$/),
      size: z.number().int().min(0).max(FLEET_FILE_BYTES),
      checksum: FleetDigest,
    }),
  }),
});
export type FleetUploadInput = z.infer<typeof FleetUploadInput>;
const Admission = z.strictObject({
  version: z.literal(1),
  requestId: z.string().uuid(),
  commandId: z.string().uuid(),
  credential: FleetSecret,
});
const Identity = {
  version: z.literal(1),
  requestId: z.string().uuid(),
  commandId: z.string().uuid(),
  machineId: MachineId,
  peer: MachineId,
  grantId: z.string().uuid(),
  directory: FleetDigest,
  requestDigest: FleetDigest,
  payloadDigest: FleetDigest,
};
export const FleetUploadPrepared = z
  .strictObject({
    ...Identity,
    transferId: z.string().uuid().nullable(),
    nextOffset: z.number().int().min(0).max(FLEET_FILE_BYTES),
    chunkBytes: z.literal(FLEET_FILE_CHUNK_BYTES),
    receipt: FleetActionReceipt.nullable(),
  })
  .refine((value) => (value.transferId === null) !== (value.receipt === null));
export const FleetUploadChunked = z.strictObject({
  ...Identity,
  transferId: z.string().uuid(),
  nextOffset: z.number().int().min(0).max(FLEET_FILE_BYTES),
});
export const FleetUploadClosed = z.strictObject({
  ...Identity,
  transferId: z.string().uuid(),
  closed: z.literal(true),
});
export const FleetUploadReceipt = z.strictObject({
  ...Identity,
  receipt: FleetActionReceipt.nullable(),
});
const signed = <S extends z.ZodType>(response: S) =>
  z.strictObject({ response, signature: FleetSignature });
const base = {
  method: "POST" as const,
  access: "peer:workspace" as const,
  params: z.strictObject({}),
  query: z.strictObject({}),
};
const Transfer = Admission.extend({
  transferId: z.string().uuid(),
  payloadDigest: FleetDigest,
});
export const fleetWorkspaceUploadApi = {
  prepare: {
    ...base,
    path: "/fleet/peer/v1/workspace/upload/prepare",
    body: Admission.extend({ input: FleetUploadInput }),
    response: signed(FleetUploadPrepared),
  },
  chunk: {
    ...base,
    path: "/fleet/peer/v1/workspace/upload/chunk",
    body: Transfer.extend({
      offset: z.number().int().min(0).max(FLEET_FILE_BYTES),
      base64: z
        .string()
        .min(4)
        .max(4 * Math.ceil(FLEET_FILE_CHUNK_BYTES / 3))
        .regex(/^[A-Za-z0-9+/]*={0,2}$/),
    }),
    response: signed(FleetUploadChunked),
  },
  close: {
    ...base,
    path: "/fleet/peer/v1/workspace/upload/close",
    body: Transfer,
    response: signed(FleetUploadClosed),
  },
  commit: {
    ...base,
    path: "/fleet/peer/v1/workspace/upload/commit",
    body: Admission.extend({
      transferId: z.string().uuid(),
      input: FleetUploadInput,
    }),
    response: signed(FleetUploadReceipt),
  },
  receipt: {
    ...base,
    path: "/fleet/peer/v1/workspace/upload/receipt",
    body: Admission.extend({ payloadDigest: FleetDigest }),
    response: signed(FleetUploadReceipt),
  },
} as const satisfies Record<string, FleetRouteContract>;

/** Credentials are authenticated separately and never enter a signed receipt. */
export function fleetUploadProofInput<T extends { credential: string }>(
  request: T,
) {
  const { credential: _credential, ...value } = request;
  return value;
}
