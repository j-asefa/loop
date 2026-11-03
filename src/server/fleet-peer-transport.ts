import { Headers, Response, request, type fetch as undiciFetch } from "undici";
import { z } from "zod";
import { FleetOrigin } from "../shared/fleet.js";
import { Problem } from "../shared/problem.js";
import { publicNetworkDispatcher, safeUrl } from "./mcp/network.js";
import type { FleetCapacity } from "./fleet-capacity.js";
import { fleetBackpressure, fleetRetryDelay } from "./fleet-backpressure.js";

const limit = 4 * 1024 * 1024;
const timeout = 15_000;

// Fetch generates browser metadata (including Sec-Fetch-Mode) even in Node.
// Machine requests use Undici's server API so strict peer admission can keep
// rejecting browser-originated traffic. This adapter preserves the injectable
// response interface used by isolated fixtures; it has no cookie jar or redirect
// interceptor, and the caller's signal covers headers and the streamed body.
const protocolRequest: typeof undiciFetch = async (url, init) => {
  if (!(url instanceof URL) || typeof init?.body !== "string")
    throw new Error("Invalid internal fleet request.");
  const response = await request(url, {
    method: "POST",
    idempotent: false,
    headers: Object.fromEntries(new Headers(init.headers)),
    body: init.body,
    dispatcher: publicNetworkDispatcher,
    signal: init.signal,
    headersTimeout: timeout,
    bodyTimeout: timeout,
  });
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (Array.isArray(value))
      for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  // Never retain error bodies or follow Location. Disposing an Undici body
  // emits an abort error; consume that cleanup event before destroying it.
  // Some status codes forbid Response bodies and invalid status codes cannot
  // be represented by Response at all, but all are safe protocol refusals.
  if (response.statusCode !== 200) {
    response.body.once("error", () => {});
    response.body.destroy();
    return new Response(null, {
      status:
        response.statusCode >= 200 && response.statusCode <= 599
          ? response.statusCode
          : 502,
      headers,
    });
  }
  return new Response(response.body, { status: response.statusCode, headers });
};

function target(origin: string, path: string) {
  try {
    const parsed = safeUrl(FleetOrigin.parse(origin));
    if (parsed.origin !== origin) throw new Error();
    return new URL(path, parsed);
  } catch {
    throw new Problem(400, "Use the machine's bare public HTTPS origin.");
  }
}

/** Fixed fleet protocol endpoints with no cookie jar, redirects or response-header
 * forwarding. DNS is checked at connection time by the existing public network
 * dispatcher, including every address returned by a mixed DNS answer. Effects
 * are sent once; durable job state owns uncertainty and receipt reconciliation. */
export class FleetPeerHttpTransport {
  constructor(
    private readonly fetcher: typeof undiciFetch = protocolRequest,
    private readonly capacity?: FleetCapacity,
  ) {}

  protected async exchange<I extends z.ZodType, O extends z.ZodType>(
    origin: string,
    route: { path: string; body: I; response: O },
    input: z.input<I>,
    signal?: AbortSignal,
    beforeDispatch?: () => void,
  ): Promise<z.output<O>> {
    const url = target(origin, "/api" + route.path),
      value = route.body.safeParse(input);
    if (!value.success)
      throw new Problem(400, "The fleet protocol request is invalid.");
    const encoded = JSON.stringify(value.data);
    if (Buffer.byteLength(encoded) > limit)
      throw new Problem(413, "The fleet protocol request is too large.");
    const release = this.capacity?.acquire("outbound", origin);
    if (this.capacity && !release)
      throw fleetBackpressure(this.capacity.retryAfter(origin));
    try {
      signal?.throwIfAborted();
      // Durable machine jobs can commit their dispatch identity after capacity
      // admission but before IO. A refusal here sends no request.
      beforeDispatch?.();
      const response = await this.fetcher(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Loop-Fleet-Version": "1",
        },
        body: encoded,
        dispatcher: publicNetworkDispatcher,
        redirect: "error",
        credentials: "omit",
        signal: signal
          ? AbortSignal.any([AbortSignal.timeout(timeout), signal])
          : AbortSignal.timeout(timeout),
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        const delay = fleetRetryDelay(response.headers.get("retry-after"));
        if (response.status === 429 || response.status >= 500)
          this.capacity?.defer(origin, delay);
        throw new Problem(
          response.status >= 400 && response.status < 500
            ? response.status
            : 502,
          "The fleet peer refused the protocol request.",
          response.status === 429 || response.status >= 500
            ? { retryAfterMs: delay }
            : undefined,
        );
      }
      const length = response.headers.get("content-length");
      if (
        !/^application\/json(?:\s*;|$)/i.test(
          response.headers.get("content-type") ?? "",
        ) ||
        (length !== null && (!/^\d+$/.test(length) || Number(length) > limit))
      ) {
        await response.body?.cancel();
        throw new Error();
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > limit) throw new Error();
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
      }
      const parsed = route.response.safeParse(
        JSON.parse(Buffer.concat(chunks, size).toString("utf8")),
      );
      if (!parsed.success) throw new Error();
      return parsed.data;
    } catch (error) {
      if (error instanceof Problem) throw error;
      // Do not expose URLs, raw bodies, headers, capabilities or upstream errors.
      throw new Problem(502, "The fleet peer response is unavailable.");
    } finally {
      release?.();
    }
  }
}
