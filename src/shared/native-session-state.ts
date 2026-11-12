import { z } from "zod";

// Companion session lifecycle statuses written in the session store (D1).
export const NativeSessionStates = [
  "starting",
  "running",
  "idle",
  "failed",
  "disconnected",
  "unavailable",
] as const;
export const NativeSessionState = z.enum(NativeSessionStates);
export type NativeSessionState = z.infer<typeof NativeSessionState>;
