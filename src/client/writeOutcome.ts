/**
 * Whether a failed owner-state write was refused. A client error (4xx) means
 * the server answered and did not apply the write, so a change shown before
 * the answer must be undone. No answer, a timeout (408), rate limiting (429),
 * a server error or a restart (5xx) leaves the outcome uncertain: keep the
 * local change and let the owner resend it.
 */
export function refusedWrite(error: unknown): boolean {
  const status =
    error && typeof error === "object"
      ? (error as { status?: unknown }).status
      : undefined;
  return (
    typeof status === "number" &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
  );
}
