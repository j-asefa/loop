import { z } from "zod";

// Scheduled send lifecycle statuses written in the scheduled-sends store (D1).
export const ScheduledSendStates = [
  "scheduled",
  "submitted",
  "failed",
  "cancelled",
] as const;
export const ScheduledSendState = z.enum(ScheduledSendStates);
export type ScheduledSendState = z.infer<typeof ScheduledSendState>;
