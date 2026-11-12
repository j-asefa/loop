import { z } from "zod";

// Stored native decision outcomes (native_decisions.state) and the transient
// answer states the decision projection reports, both written by the native
// decision paths (D1).
export const NativeDecisionStates = ["pending", "expired", "resolved"] as const;
export const NativeDecisionState = z.enum(NativeDecisionStates);
export type NativeDecisionState = z.infer<typeof NativeDecisionState>;

export const NativeAnswerStates = ["deciding", "pending", "unknown"] as const;
export const NativeAnswerState = z.enum(NativeAnswerStates);
export type NativeAnswerState = z.infer<typeof NativeAnswerState>;
