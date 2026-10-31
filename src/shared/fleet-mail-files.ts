import { z } from "zod";
import { FleetMailEnvelope } from "./fleet-mail.js";
import { MAX_UPLOAD_BYTES } from "./uploads.js";

export const FLEET_MAIL_FILE_CHUNK_BYTES = 192 * 1024;
export const FLEET_MAIL_STAGING_BYTES = 256 * 1024 * 1024;

/** Fixed peer protocol input. No agent-supplied URL or local path is accepted. */
export const FleetMailFileChunk = z.strictObject({
  envelope: FleetMailEnvelope,
  reservationId: z.string().uuid(),
  fileId: z.string().uuid(),
  offset: z.number().int().min(0).max(MAX_UPLOAD_BYTES),
  base64: z.string().max(4 * Math.ceil(FLEET_MAIL_FILE_CHUNK_BYTES / 3)),
});
