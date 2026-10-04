import { fetch as undiciFetch } from "undici";
import { db, now } from "./db.js";
import { readSecret, type MCPConnection } from "./mcp/client.js";
import { isGithubMcpUrl } from "../shared/github.js";

// Server-side GitHub access with the owner's official GitHub connection
// (api.githubcopilot.com/mcp). The token stays on the server: it never
// reaches a model, a native shell or the browser. Callers decide what each
// request may do; this module only carries it.

type GithubFetch = (url: string, init: RequestInit) => Promise<Response>;
// undici's own fetch, not the global one: once the undici package is loaded
// (the MCP network layer loads it) it becomes the global dispatcher, and
// Node's built-in fetch then returns GitHub's gzipped responses undecoded.
let githubFetch: GithubFetch = (url, init) =>
  undiciFetch(url, init as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
// Browser fixtures point this at a dead local address, never at GitHub.
let githubApi = process.env.LOOP_GITHUB_API_URL || "https://api.github.com";
/** Tests swap GitHub for a fixture (or only its address); returns a restore function. */
export function withGithubFixture(fetcher: GithubFetch | undefined, base = githubApi) {
  const previous = { githubFetch, githubApi };
  if (fetcher) githubFetch = fetcher;
  githubApi = base;
  return () => ({ githubFetch, githubApi } = previous);
}

/**
 * The distinct tokens of the owner's connected official GitHub integrations,
 * oldest connection first. Never inferred from a connection's display name.
 */
export function githubTokens(owner: string) {
  const connections = db
    .prepare(
      "SELECT * FROM mcp_connections WHERE owner_id=? AND status='connected' ORDER BY created_at,rowid",
    )
    .all(owner) as MCPConnection[];
  const tokens = new Set<string>();
  for (const connection of connections) {
    if (!isGithubMcpUrl(connection.url)) continue;
    const secret = readSecret(connection);
    if (secret.stdio) continue;
    const authorization = Object.entries(secret.headers || {}).find(
      ([key]) => key.toLowerCase() === "authorization",
    )?.[1];
    const token =
      secret.type === "bearer"
        ? secret.token
        : secret.type === "oauth"
          ? secret.tokens?.access_token
          : secret.type === "headers"
            ? authorization?.match(/^Bearer\s+(\S+)$/i)?.[1]
            : undefined;
    if (
      typeof token === "string" &&
      token.length > 0 &&
      token.length <= 8192 &&
      !/[\r\n\0]/.test(token)
    )
      tokens.add(token);
  }
  return [...tokens];
}

export class GithubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    // Set when GitHub rate-limited the request: when to try again.
    readonly retryAt?: number,
  ) {
    super(message);
  }
}

/** When a rate-limited response may be retried, or undefined if it wasn't one. */
function rateLimitRetry(response: Response, time = now()) {
  const after = Number(response.headers.get("retry-after"));
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  const limited =
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.get("x-ratelimit-remaining") === "0" ||
        response.headers.has("retry-after")));
  if (!limited) return undefined;
  if (after > 0) return time + after * 1000;
  if (reset > 0) return reset * 1000;
  return time + 60_000;
}

// GitHub's own explanation of a rejected request ("Pull Request is not
// mergeable", "Can not approve your own pull request"), kept to one line.
async function githubReason(response: Response) {
  const body = (await response.json().catch(() => null)) as {
    message?: unknown;
    errors?: unknown;
  } | null;
  const detail = Array.isArray(body?.errors)
    ? body.errors
        .map((e) => (typeof e === "string" ? e : (e as any)?.message))
        .find((m) => typeof m === "string" && m.trim())
    : undefined;
  const message = typeof body?.message === "string" ? body.message : "";
  return [message, detail]
    .filter(Boolean)
    .join(": ")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .slice(0, 300);
}

/** Throws a rate-limited or failed GitHub response as a GithubError. */
async function refused(response: Response) {
  const retryAt = rateLimitRetry(response);
  if (retryAt)
    throw new GithubError(
      "GitHub's rate limit was reached. Try again after it resets.",
      response.status,
      retryAt,
    );
  if (!response.ok) {
    const reason = await githubReason(response);
    throw new GithubError(
      response.status === 401
        ? "GitHub rejected the connection. Reconnect GitHub in Tools."
        : reason || `GitHub returned ${response.status}.`,
      response.status,
    );
  }
}

/** A GitHub REST response with its Link header, for paging. */
export async function githubRest<T>(
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
) {
  const response = await githubFetch(githubApi + path, {
    method: init.method || "GET",
    headers: {
      accept: "application/vnd.github+json",
      authorization: "Bearer " + token,
      "x-github-api-version": "2022-11-28",
      "user-agent": "Loop",
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(20_000),
  });
  await refused(response);
  return {
    data: (response.status === 204 ? null : await response.json()) as T,
    link: response.headers.get("link") || "",
  };
}

/**
 * A GitHub GraphQL query. A response without data is thrown like a REST
 * failure; partial data (an organization's SSO hiding some results) is
 * returned with those fields null, for the caller to check.
 */
export async function githubGraphql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown> = {},
) {
  const { data } = await githubRest<{
    data?: T | null;
    errors?: { type?: string; message?: string }[];
  }>(token, "/graphql", { method: "POST", body: { query, variables } });
  const error = data?.errors?.[0];
  if (!data?.data) {
    const missing = error?.type === "NOT_FOUND";
    throw new GithubError(
      missing
        ? "GitHub could not find this with your connection."
        : error?.type === "RATE_LIMITED"
          ? "GitHub's rate limit was reached. Try again after it resets."
          : (error?.message || "GitHub returned no data.").slice(0, 300),
      missing ? 404 : error?.type === "FORBIDDEN" ? 403 : 502,
      error?.type === "RATE_LIMITED" ? now() + 60_000 : undefined,
    );
  }
  return data.data;
}

/**
 * A file's bytes from GitHub's REST API (the raw media type), refused once
 * it is larger than `maxBytes` rather than read whole into memory.
 */
export async function githubRaw(token: string, path: string, maxBytes: number) {
  const response = await githubFetch(githubApi + path, {
    method: "GET",
    headers: {
      accept: "application/vnd.github.raw+json",
      authorization: "Bearer " + token,
      "x-github-api-version": "2022-11-28",
      "user-agent": "Loop",
    },
    signal: AbortSignal.timeout(60_000),
  });
  await refused(response);
  const tooLarge = () =>
    new GithubError("This file is too large to show here. Open it on GitHub.", 413);
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw tooLarge();
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  for (;;) {
    const next = await reader?.read();
    if (!next || next.done) break;
    size += next.value.byteLength;
    if (size > maxBytes) {
      await reader!.cancel();
      throw tooLarge();
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks);
}
