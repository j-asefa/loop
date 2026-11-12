import { z } from "zod";

// Connection lifecycle statuses written by the connection store (D1).
export const ConnectionStatuses = [
  "connected",
  "disconnected",
  "needs_reconnect",
  "needs_sign_in",
] as const;
export const ConnectionStatus = z.enum(ConnectionStatuses);
export type ConnectionStatus = z.infer<typeof ConnectionStatus>;
