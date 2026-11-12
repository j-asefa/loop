import { z } from "zod";

// Import lifecycle statuses written in src/server/imports.ts (D1).
export const ImportStatuses = [
  "preview",
  "queued",
  "running",
  "paused",
  "cancelled",
  "completed",
  "failed",
] as const;
export const ImportStatus = z.enum(ImportStatuses);
export type ImportStatus = z.infer<typeof ImportStatus>;
