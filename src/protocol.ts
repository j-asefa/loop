import { z } from "zod";
import type {
  ActivityEvent,
  ActivityCapabilities,
} from "./agent-activities.js";

export const Harness = z.enum([
  "pi",
  "claude",
  "codex",
  "opencode",
  "antigravity",

  "muse",
  "grok",
  "acp",
]);
export type Harness = z.infer<typeof Harness>;
export type Status =
  | "starting"
  | "ready"
  | "running"
  | "awaiting-input"
  | "completed"
  | "interrupted"
  | "failed"
  | "stopped";
export type Billing = {
  mode: "subscription" | "existing";
  description: string;
  provider?: string;
  model?: string;
};
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
export type Item = {
  id: string;
  kind: "user" | "assistant" | "tool" | "notice";
  text: string;
  title?: string;
  status?: string;
  phase?: "commentary" | "final_answer";
};
export type AdapterEvent =
  // NativeSessions owns adapter ingress and persists the display projection.
  | ActivityEvent
  | { type: "usage"; usage: { input_tokens: number; output_tokens: number } }
  | { type: "activity_capabilities"; capabilities: ActivityCapabilities }
  | { type: "status"; status: Status; detail?: string; recoverable?: boolean }
  | { type: "metadata"; nativeSession: string; billing?: Billing }
  | { type: "item"; item: Item }
  | { type: "delta"; id: string; text: string }
  | { type: "request"; request: Request }
  | { type: "resolved"; id: string }
  | { type: "error"; message: string };
export const ItemSchema = z.object({
  id: z.string(),
  kind: z.enum(["user", "assistant", "tool", "notice"]),
  text: z.string(),
  title: z.string().optional(),
  status: z.string().optional(),
});
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
