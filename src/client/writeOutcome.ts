/**
 * What a failed owner-state write means for a change shown before the
 * answer:
 * - "applied": the server says it completed the write, so keep the change
 *   and never resend it.
 * - "refused": the server did not apply it, so undo the change.
 * - "uncertain": it may or may not have applied, so keep the change and let
 *   the owner resend it; never resend it automatically.
 *
 * An explicit execution outcome from the server decides first, because the
 * HTTP status alone cannot (a remote source answers 503 for a completed
 * write and 409 for an unknown one). Without one, a client error (4xx other
 * than 408 and 429) is a refusal, and no answer, a timeout, rate limiting
 * or a server error (5xx) is uncertain.
 */
export type WriteOutcome = "applied" | "refused" | "uncertain";

export function writeOutcome(error: unknown): WriteOutcome {
  const failure =
    error && typeof error === "object"
      ? (error as { status?: unknown; executionOutcome?: unknown })
      : undefined;
  if (failure?.executionOutcome === "completed") return "applied";
  if (failure?.executionOutcome === "refused") return "refused";
  if (failure?.executionOutcome === "unknown") return "uncertain";
  const status = failure?.status;
  return typeof status === "number" &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
    ? "refused"
    : "uncertain";
}
