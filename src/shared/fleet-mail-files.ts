import { z } from "zod";
import { FleetMailEnvelope, FLEET_MAIL_MAX_FILES } from "./fleet-mail.js";
import { MAX_UPLOAD_BYTES } from "./uploads.js";

export const FLEET_MAIL_FILE_CHUNK_BYTES = 192 * 1024;
export const FLEET_MAIL_STAGING_BYTES = 256 * 1024 * 1024;
// One maximum-size envelope fits, while another peer retains staging capacity.
export const FLEET_MAIL_PEER_STAGING_BYTES =
  FLEET_MAIL_MAX_FILES * MAX_UPLOAD_BYTES;

/** Fixed peer protocol input. No agent-supplied URL or local path is accepted. */
export const FleetMailFileChunk = z.strictObject({
  envelope: FleetMailEnvelope,
  reservationId: z.string().uuid(),
  fileId: z.string().uuid(),
  offset: z.number().int().min(0).max(MAX_UPLOAD_BYTES),
  base64: z.string().max(4 * Math.ceil(FLEET_MAIL_FILE_CHUNK_BYTES / 3)),
});
