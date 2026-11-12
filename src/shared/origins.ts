import { z } from "zod";

// Conversation and agent origins, read from the writers: loop conversations
// are the default; loop-continuation marks a continued thread; imports and
// native conversations declare theirs (D1).
export const ConversationOrigins = [
  "loop",
  "loop-continuation",
  "loop-fork",
  "native",
  "import",
] as const;
export const ConversationOrigin = z.enum(ConversationOrigins);
export type ConversationOrigin = z.infer<typeof ConversationOrigin>;

export const AgentOrigins = ["loop", "import"] as const;
export const AgentOrigin = z.enum(AgentOrigins);
export type AgentOrigin = z.infer<typeof AgentOrigin>;
