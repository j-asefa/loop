import { codexToolApproval } from "../../../src/shared/codex-approval";
import type { ApiNativeDecision } from "./api/types";

/**
 * The native request a decision carries, as JSON text in `request`. Mirrors
 * `Request` in src/shared/protocol.ts, which mobile cannot import because that
 * module loads zod. test/mobile-logic.test.ts keeps the two assignable.
 */
export type NativeDecisionRequest = {
  id: string;
  kind: "approval" | "question";
  title: string;
  detail: string;
  choices?: string[];
  completionUrl?: string;
  allow?: string;
  questions?: {
    id: string;
    title: string;
    options?: string[];
    multiple?: boolean;
    secret?: boolean;
  }[];
};

export type NativeDecisionView = {
  kind: "approval" | "question";
  title: string;
  agentName: string;
  /** Plain text to show: the shell command, tool message or request detail. */
  detail: string;
  choices: string[];
  questions: {
    id: string;
    title: string;
    options: string[];
    multiple: boolean;
    secret: boolean;
  }[];
  completionUrl?: string;
};

function parseJson(text: string | null | undefined): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

/** Same reading as NativeRequestDetails on the web. */
function detailText(detail: string): string {
  const structured = parseJson(detail);
  if (!record(structured)) return detail;
  const tool = codexToolApproval(structured);
  if (tool) {
    return `${tool.server}${tool.tool ? ` · ${tool.tool}` : ""}\n${tool.message}`;
  }
  // Claude nests the shell command in its tool input.
  const command =
    structured.command ??
    (record(structured.input) ? structured.input.command : undefined);
  if (command !== undefined) {
    return typeof command === "string" ? command : JSON.stringify(command);
  }
  return JSON.stringify(structured, null, 2);
}

export function readNativeDecision(
  decision: ApiNativeDecision,
): NativeDecisionView {
  const raw = parseJson(decision.request);
  const request = record(raw) ? raw : {};
  const kind = request.kind === "approval" ? "approval" : "question";
  const questions = Array.isArray(request.questions)
    ? request.questions.filter(record).flatMap((q) =>
        typeof q.id === "string"
          ? [
              {
                id: q.id,
                title: typeof q.title === "string" ? q.title : "",
                options: strings(q.options),
                multiple: q.multiple === true,
                secret: q.secret === true,
              },
            ]
          : [],
      )
    : [];
  const completionUrl =
    typeof request.completionUrl === "string" &&
    request.completionUrl.startsWith("https://")
      ? request.completionUrl
      : undefined;
  return {
    kind,
    title:
      typeof request.title === "string" && request.title.trim()
        ? request.title
        : kind === "approval"
          ? "Approval needed"
          : "Question",
    agentName: decision.name || "agent",
    detail:
      typeof request.detail === "string" ? detailText(request.detail) : "",
    choices: strings(request.choices),
    questions,
    completionUrl,
  };
}

export function choiceTone(choice: string): "allow" | "deny" | "other" {
  if (["allow", "accept", "once", "confirm"].includes(choice)) return "allow";
  if (["deny", "reject", "decline", "cancel"].includes(choice)) return "deny";
  return "other";
}

export function choiceLabel(choice: string, completionUrl?: string): string {
  if (completionUrl && choice === "accept") return "Completed";
  return choice.charAt(0).toUpperCase() + choice.slice(1);
}

/** The answer body the server's validateAnswer accepts for a question form. */
export function questionAnswer(
  questions: NativeDecisionView["questions"],
  answers: Record<string, string[]>,
): Record<string, string[]> {
  return Object.fromEntries(questions.map((q) => [q.id, answers[q.id] ?? []]));
}

/**
 * The server answers `resolved` once the harness accepted the decision. Any
 * other state means delivery is uncertain and must not be sent again
 * automatically.
 */
export function decisionDelivered(response: { state: string }): boolean {
  return response.state === "resolved";
}
