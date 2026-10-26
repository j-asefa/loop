import { z } from "zod";

export type UploadedFile = {
  id: string;
  objectId: string;
  name: string;
  mime: string;
  size: number;
  // An agent's published file, downloaded from its artifact, not an upload.
  published?: boolean;
};
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_MESSAGE_FILES = 8;

export const AttachmentIds = z
  .array(z.string().uuid())
  .max(MAX_MESSAGE_FILES)
  .default([])
  .transform((ids) => [...new Set(ids)]);
