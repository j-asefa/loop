import { z } from "zod";

// The one closed set of message roles, shared by the message row schema, the
// cards and the mobile projections (D1).
export const MessageRoles = ["user", "assistant", "system", "tool"] as const;
export const MessageRole = z.enum(MessageRoles);
export type MessageRole = z.infer<typeof MessageRole>;
