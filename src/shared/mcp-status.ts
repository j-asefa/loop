import { z } from "zod";

// MCP connection lifecycle statuses written by the MCP connection store (D1).
export const McpConnectionStatuses = [
  "connected",
  "disconnected",
  "needs_auth",
  "disabled",
] as const;
export const McpConnectionStatus = z.enum(McpConnectionStatuses);
export type McpConnectionStatus = z.infer<typeof McpConnectionStatus>;
