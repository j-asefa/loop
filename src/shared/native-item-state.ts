import { z } from "zod";

// Native conversation item lifecycle statuses written by the native
// projectors (D1).
export const NativeItemStates = [
  "running",
  "ready",
  "waiting",
  "in_progress",
  "pending",
  "failed",
  "interrupted",
  "completed",
] as const;
export const NativeItemState = z.enum(NativeItemStates);
export type NativeItemState = z.infer<typeof NativeItemState>;
