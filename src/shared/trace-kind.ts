import { z } from "zod";

// Run trace kinds written by recordTrace (D1).
export const TraceKinds = ["message", "tool"] as const;
export const TraceKind = z.enum(TraceKinds);
export type TraceKind = z.infer<typeof TraceKind>;
