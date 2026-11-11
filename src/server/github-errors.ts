import { Problem } from "../shared/problem.js";

export const GITHUB_PULL_MISSING =
  "GitHub could not find this pull request with your connection.";
export type GithubErrorContext = "request" | "watch";

export class GithubError extends Error {
  readonly reason:
    "rate-limit" | "authentication" | "forbidden" | "missing" | "response";
  constructor(
    message: string,
    readonly status: number,
    readonly retryAt?: number,
    context: GithubErrorContext = "request",
  ) {
    const reason = retryAt
      ? "rate-limit"
      : status === 401
        ? "authentication"
        : status === 403
          ? "forbidden"
          : status === 404
            ? "missing"
            : "response";
    super(
      context === "watch"
        ? reason === "rate-limit"
          ? "GitHub's rate limit was reached; watching continues after it resets."
          : reason === "authentication"
            ? "GitHub rejected the connection. Reconnect GitHub to keep watching."
            : reason === "missing"
              ? GITHUB_PULL_MISSING
              : `GitHub returned ${status}.`
        : message,
    );
    this.reason = reason;
  }
}

/** GitHub failures as Loop problems; never a 401, which signs you out of Loop. */
export function githubProblem(error: unknown, write = false): never {
  if (error instanceof Problem) throw error;
  if (error instanceof GithubError)
    throw new Problem(
      error.reason === "rate-limit"
        ? 429
        : error.reason === "authentication"
          ? 409
          : [403, 404, 405, 409, 413, 422].includes(error.status)
            ? error.status === 405
              ? 409
              : error.status
            : 502,
      error.message,
    );
  if (
    (error as Error)?.name === "TimeoutError" ||
    (error as Error)?.name === "AbortError"
  )
    throw new Problem(
      504,
      write
        ? "GitHub didn't answer in time. Refresh to see whether it went through before trying again."
        : "GitHub didn't answer in time. Try again.",
    );
  throw new Problem(502, "Could not reach GitHub. Try again.");
}
