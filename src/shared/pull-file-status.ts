import { z } from "zod";

// GitHub pull-request file statuses, mapped in the pulls projection (the API
// status with a "modified" fallback) (D1).
export const PullFileStatuses = [
  "added",
  "modified",
  "removed",
  "renamed",
] as const;
export const PullFileStatus = z.enum(PullFileStatuses);
export type PullFileStatus = z.infer<typeof PullFileStatus>;
