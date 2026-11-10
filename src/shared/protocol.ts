import { z } from "zod";

export { Harness } from "./harnesses.js";
export type Status =
  | "starting"
  | "ready"
  | "running"
  | "awaiting-input"
  | "completed"
  | "interrupted"
  | "failed"
  | "stopped";
export const Billing = z.strictObject({
  mode: z.enum(["subscription", "existing"]),
  description: z.string(),
  provider: z.string().optional(),
  // Codex config/read reports an unset default model as null.
  model: z.string().nullish(),
});
export type Billing = z.infer<typeof Billing>;
export type Capabilities = {
  approvals: boolean;
  questions: boolean;
  resume: boolean;
  liveAttach: boolean;
  terminal: boolean;
};
export type Request = {
  id: string;
  kind: "approval" | "question";
  title: string;
  detail: string;
  choices?: string[];
  /** Explicit browser completion; never a standing tool permission. */
  completionUrl?: string;
  /** The choice that permits only this tool call, when the request is one. */
  allow?: string;
  questions?: {
    id: string;
    title: string;
    options?: string[];
    multiple?: boolean;
    secret?: boolean;
  }[];
};
export const ItemSchema = z.object({
  id: z.string(),
  kind: z.enum(["user", "assistant", "tool", "notice"]),
  text: z.string(),
  title: z.string().optional(),
  status: z.string().optional(),
  phase: z.enum(["commentary", "final_answer"]).optional(),
});
export type Item = z.infer<typeof ItemSchema>;
export function validateAnswer(
  request: Request,
  answer: Record<string, unknown>,
) {
  if (request.kind === "approval") {
    if (
      typeof answer.choice !== "string" ||
      !request.choices?.includes(answer.choice)
    )
      throw new Error("Select a listed native decision.");
  } else {
    for (const q of request.questions ?? []) {
      const a = answer[q.id];
      if (
        !Array.isArray(a) ||
        !a.every((x) => typeof x === "string" && x.length <= 8000) ||
        a.length > 30
      )
        throw new Error("Invalid question answer.");
    }
  }
}
