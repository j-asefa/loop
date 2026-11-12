import { z } from "zod";

// GitHub pull-request file statuses, mapped in the pulls projection. The set
// is GitHub's documented PR-file statuses plus a "modified" fallback for
// anything outside it (D1).
export const PullFileStatuses = [
  "added",
  "modified",
  "removed",
  "renamed",
  "copied",
  "changed",
  "unchanged",
] as const;
export const PullFileStatus = z.enum(PullFileStatuses);
export type PullFileStatus = z.infer<typeof PullFileStatus>;
