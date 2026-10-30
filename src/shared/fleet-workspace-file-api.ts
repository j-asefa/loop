import { z } from "zod";
import { FleetDigest, FleetSignature, MachineId } from "./fleet.js";
import { FleetSecret } from "./fleet-credentials.js";
import { MAX_UPLOAD_BYTES } from "./uploads.js";
import {
  workspaceApi,
  type RouteContract,
  type FleetRouteContract,
} from "./workspace-api.js";

export const FLEET_FILE_BYTES = MAX_UPLOAD_BYTES;
export const FLEET_FILE_CHUNK_BYTES = 256 * 1024;
export const fleetFileRoutes = {
  artifactFile: workspaceApi.artifactFile,
  objectFile: workspaceApi.objectFile,
  agentTracesExport: workspaceApi.agentTracesExport,
} as const satisfies Record<
  string,
  RouteContract & { method: "GET"; kind: "stream" }
>;
export const FleetFileSelection = z
  .strictObject({
    route: z.enum(["artifactFile", "objectFile", "agentTracesExport"]),
    params: z.strictObject({ id: z.string().min(1).max(100) }),
    query: z.strictObject({
      preview: z.enum(["1", "html"]).optional(),
      run: z.string().min(1).max(100).optional(),
    }),
  })
  .superRefine((value, context) => {
    if (
      value.route === "agentTracesExport"
        ? !value.query.run || value.query.preview !== undefined
        : value.query.run !== undefined
    )
      context.addIssue({
        code: "custom",
        path: ["query"],
        message: "Choose the query for this file route.",
      });
  });
export type FleetFileSelection = z.infer<typeof FleetFileSelection>;
export const FleetFileMetadata = z.strictObject({
  size: z.number().int().min(0).max(FLEET_FILE_BYTES),
  checksum: FleetDigest,
  mediaType: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[\x20-\x7e]+$/),
  disposition: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[\x20-\x7e]+$/),
});
export type FleetFileMetadata = z.infer<typeof FleetFileMetadata>;
const Admission = z.strictObject({
  version: z.literal(1),
  requestId: z.string().uuid(),
  credential: FleetSecret,
});
const ResponseIdentity = {
  version: z.literal(1),
  requestId: z.string().uuid(),
  requestDigest: FleetDigest,
  machineId: MachineId,
  peer: MachineId,
  grantId: z.string().uuid(),
  directory: FleetDigest,
  transferId: z.string().uuid(),
};
export const FleetFileOpened = z.strictObject({
  ...ResponseIdentity,
  file: FleetFileMetadata,
  chunkBytes: z.literal(FLEET_FILE_CHUNK_BYTES),
});
export const FleetFileChunk = z.strictObject({
  ...ResponseIdentity,
  checksum: FleetDigest,
  offset: z.number().int().min(0).max(FLEET_FILE_BYTES),
  nextOffset: z.number().int().min(0).max(FLEET_FILE_BYTES).nullable(),
  base64: z
    .string()
    .max(4 * Math.ceil(FLEET_FILE_CHUNK_BYTES / 3))
    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
});
export const FleetFileClosed = z.strictObject({
  ...ResponseIdentity,
  closed: z.literal(true),
});
const signed = <S extends z.ZodType>(response: S) =>
  z.strictObject({ response, signature: FleetSignature });
const base = {
  method: "POST" as const,
  access: "peer:workspace" as const,
  params: z.strictObject({}),
  query: z.strictObject({}),
};
export const fleetWorkspaceFileApi = {
  open: {
    ...base,
    path: "/fleet/peer/v1/workspace/file/open",
    body: Admission.extend({ selection: FleetFileSelection }),
    response: signed(FleetFileOpened),
  },
  chunk: {
    ...base,
    path: "/fleet/peer/v1/workspace/file/chunk",
    body: Admission.extend({
      transferId: z.string().uuid(),
      offset: z.number().int().min(0).max(FLEET_FILE_BYTES),
    }),
    response: signed(FleetFileChunk),
  },
  close: {
    ...base,
    path: "/fleet/peer/v1/workspace/file/close",
    body: Admission.extend({ transferId: z.string().uuid() }),
    response: signed(FleetFileClosed),
  },
} as const satisfies Record<string, FleetRouteContract>;
