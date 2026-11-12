import { z } from "zod";

// Native conversation item lifecycle statuses written by the native
// projectors (D1).
export const NativeItemStates = [
  "running",
  "ready",
  "waiting",
  "in_progress",
  "pending",
  "declined",
  "error",
  "failed",
  "interrupted",
  "completed",
] as const;
export const NativeItemState = z.enum(NativeItemStates);
export type NativeItemState = z.infer<typeof NativeItemState>;

// Harness item statuses arrive in provider spellings (Codex uses inProgress,
// awaiting-input, rejected...). Normalize them to the closed set so a stored
// item can never make the native transcript unreadable (D2). Unknown statuses
// fall back to running unless the item finished.
export function normalizeItemStatus(
  status: string | null | undefined,
  completed = false,
): NativeItemState {
  // The activity projector recognises running/waiting/completed/failed only;
  // both progress spellings must land on "running" so a tool is never
  // recorded as unknown progress (docs/cards-api.md tool activity).
  switch (status) {
    case "in_progress":
    case "inProgress":
      return "running";
    case "running":
      return "running";
    case "waiting":
    case "awaiting-input":
      return "waiting";
    case "pending":
      return "pending";
    case "declined":
    case "rejected":
      return "declined";
    case "error":
      return "error";
    case "failed":
      return "failed";
    case "interrupted":
    case "cancelled":
      return "interrupted";
    case "completed":
    case "done":
      return "completed";
    case "ready":
      return "ready";
    default:
      return completed ? "completed" : "running";
  }
}
