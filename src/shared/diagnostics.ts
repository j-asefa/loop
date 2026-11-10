import { redactValues } from "./redaction.js";

// Only error summaries cross this boundary, never stderr, stacks, request bodies,
// or environment dumps. Redact before clipping so token prefixes cannot escape.
export function diagnosticText(
  value: unknown,
  secrets: unknown[] = [],
): string {
  if (typeof value !== "string") return "";
  return redactValues(value, secrets)
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .replace(
      /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=._~-]+/gi,
      "[redacted authorization]",
    )
    .replace(
      /\b(?:sk-[a-zA-Z0-9_-]{12,}|gh[pousr]_[a-zA-Z0-9_]{12,}|github_pat_[a-zA-Z0-9_]{12,})\b/g,
      "[redacted]",
    )
    .replace(/https?:\/\/[^\s<>"']+/gi, (text) => {
      try {
        const url = new URL(text);
        url.username = "";
        url.password = "";
        if (url.search) url.search = "?redacted";
        url.hash = "";
        return url.toString();
      } catch {
        return "[redacted URL]";
      }
    })
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret|authorization)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      "$1[redacted]",
    )
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .slice(0, 1200);
}
type ErrorDetails = {
  name?: unknown;
  code?: unknown;
  status?: unknown;
  message?: unknown;
  cause?: ErrorDetails;
};
export function errorFacts(value: unknown): {
  type: string;
  code?: string | number;
  causes?: (string | number)[];
  status?: number;
} {
  const error = value as ErrorDetails | null | undefined;
  const safe = (value: unknown) =>
    typeof value === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(value)
      ? value
      : undefined;
  const number = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const causes: (string | number)[] = [];
  for (
    let current = error, i = 0;
    current && i < 4;
    current = current.cause, i++
  ) {
    const code = number(current.code) ?? safe(current.code);
    if (code !== undefined && !causes.includes(code)) causes.push(code);
  }
  return {
    type: safe(error?.name) || "Error",
    ...(causes.length ? { code: causes[0], causes } : {}),
    ...(number(error?.status) !== undefined
      ? { status: error!.status as number }
      : {}),
  };
}
export function errorSummary(
  error: unknown,
  secrets: unknown[] = [],
  includeMessage = true,
): string {
  const facts = errorFacts(error);
  const label = [facts.type, facts.code, facts.status && `HTTP ${facts.status}`]
    .filter((value: unknown) => value !== undefined && value !== false)
    .join(" · ");
  const message = includeMessage
    ? diagnosticText(
        (error as ErrorDetails | null | undefined)?.message,
        secrets,
      )
    : "";
  return message ? `${label}: ${message}` : label;
}
export class RuntimeFailure extends Error {
  declare details: Record<string, unknown>;
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "RuntimeFailure";
    this.details = details;
  }
}

export function runtimeFailureFacts(
  details: unknown,
): Record<string, string | number> {
  if (!details || typeof details !== "object") return {};
  return Object.fromEntries(
    Object.entries(details).filter(
      ([key, value]) =>
        ["phase", "code", "exitCode", "signal", "subtype"].includes(key) &&
        ((typeof value === "string" &&
          /^[A-Za-z0-9_.:/-]{1,80}$/.test(value)) ||
          (typeof value === "number" && Number.isFinite(value))),
    ),
  ) as Record<string, string | number>;
}
