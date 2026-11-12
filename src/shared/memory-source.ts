import { z } from "zod";

// Memory source fields written in src/server/memory.ts (D1). `role` mixes the
// message role for message sources with the literal "note" for artifact notes.
export const MemorySourceKinds = ["message", "artifact", "note"] as const;
export const MemorySourceKind = z.enum(MemorySourceKinds);
export type MemorySourceKind = z.infer<typeof MemorySourceKind>;

export const MemorySourceOrigins = ["loop", "hapi"] as const;
export const MemorySourceOrigin = z.enum(MemorySourceOrigins);
export type MemorySourceOrigin = z.infer<typeof MemorySourceOrigin>;

export const MemorySourceRoles = [
  "user",
  "assistant",
  "system",
  "tool",
  "note",
  "user-note",
] as const;
export const MemorySourceRole = z.enum(MemorySourceRoles);
export type MemorySourceRole = z.infer<typeof MemorySourceRole>;
