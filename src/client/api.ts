import { isFleetReadContract } from "../shared/fleet-workspace-api";
import { routePath } from "../shared/route-path";
export { routePath } from "../shared/route-path";
import type { RouteContract, ClientRouteContract, RouteInput, RouteResponse } from "../shared/workspace-api";
import { WorkspaceClock } from "../shared/workspace-events";
import { capabilities } from "./capabilities";
import { executionSourceId, sourceApiPathAt } from "./sourceRouting";
import { viewGeneration } from "./viewCache";
import { prepareFleetCommand } from "./fleetCommand";
let csrf = "";
let sessionRequest: Promise<void> | undefined;
let backoffGeneration = -1;
let clockRequestId = 0;
const readBackoff = new Map<string, number>();
export const RATE_LIMITED = "Updates are paused briefly. Retrying automatically…";

export function isExecutionRefused(error: unknown): boolean {
  return (error as { executionOutcome?: string } | null)?.executionOutcome === "refused";
}

export function isRateLimited(error: unknown): error is Error & { status: 429; retryAt: number } {
  const value = error as { status?: number; retryAt?: number } | null;
  return value?.status === 429 && Number.isFinite(value.retryAt);
}
/** Absolute deadlines avoid extending a server cooldown on every fallback tick. */
export function retryAfter(error: unknown): number {
  return isRateLimited(error) ? Math.max(0, error.retryAt - Date.now()) : 0;
}
function limited(retryAt: number) {
  // Only read owners that actually schedule a retry may promise one in the UI.
  return Object.assign(new Error("Too many requests. Try again shortly."), {
    status: 429, retryAt, retryAfterMs: Math.max(0, retryAt - Date.now()),
  });
}
function retryDeadline(header: string | null) {
  const seconds = header && /^\d+(?:\.\d+)?$/.test(header.trim()) ? Number(header) : NaN;
  const date = header ? Date.parse(header) : NaN;
  const delay = Number.isFinite(seconds) ? seconds * 1000 : date - Date.now();
  // A zero/past deadline still represents a refusal. Avoid immediate retry
  // loops when a proxy rounds down or its clock trails the client's clock.
  return Date.now() + (Number.isFinite(delay) ? Math.max(1000, delay) : 1000);
}
/**
 * Loop55's connection service answers this while the application restarts. The
 * request never reached Loop55; nothing about pairing or the session changed.
 */
const restarting = (r: Response) =>
  r.status === 503 && (r.headers.get("x-loop55-unavailable") ?? r.headers.get("x-loop-unavailable")) === "restarting";
export const RECONNECTING = "Loop55 is reconnecting… Work on your computer continues.";
function reconnectingError() {
  window.dispatchEvent(new Event("loop55-reconnecting"));
  return Object.assign(new Error(RECONNECTING), {
    status: 503,
    reconnecting: true,
  });
}
export async function authorize(signal?: AbortSignal) {
  signal?.throwIfAborted();
  if ((!capabilities.pairedDevices && !executionSourceId()) || csrf) return;
  if (!sessionRequest)
    sessionRequest = (async () => {
      const response = await fetch("/session", {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (restarting(response)) throw reconnectingError();
      if (!response.ok) {
        // Only a refusal ends the session; a server or relay failure doesn't.
        if (response.status < 500)
          window.dispatchEvent(new Event("loop55-auth-expired"));
        throw new Error(
          response.status < 500
            ? "Pair this device from the desktop."
            : "Couldn’t reach Loop55. Try again.",
        );
      }
      csrf = (await response.json()).csrf;
    })().finally(() => {
      sessionRequest = undefined;
    });
  const pending = sessionRequest;
  if (!signal) {
    await pending;
    return;
  }
  // A caller owns only its wait, not the shared session request. Cancelling an
  // unsent command must release its Web Lock without aborting other callers.
  await new Promise<void>((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener("abort", aborted);
      reject(signal.reason);
    };
    signal.addEventListener("abort", aborted, { once: true });
    pending.then(
      () => { signal.removeEventListener("abort", aborted); resolve(); },
      (error) => { signal.removeEventListener("abort", aborted); reject(error); },
    );
    if (signal.aborted) aborted();
  });
}
export function clearAuthorization() {
  csrf = "";
}
async function sendRequest(path: string, init: RequestInit = {}, current: () => void = () => {}, dispatch: () => void = () => {}) {
  current();
  const method = init.method || "GET";
  const headers = new Headers(init.headers);
  if (!["GET", "HEAD"].includes(method.toUpperCase())) {
    await authorize(init.signal ?? undefined);
    headers.set("x-loop55-csrf", csrf);
  }
  current();
  dispatch();
  return fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
    cache: "no-store",
  });
}

/** Browser href/src consumers use the same validated, source-bound address. */
export function routeUrl<C extends RouteContract & { method: "GET" }>(contract: C, input: RouteInput<C>, sourceId: string) {
  return sourceApiPathAt(`/api${routePath(contract, input)}` as const, sourceId);
}
/** File previews also need attachment headers; their existing reader owns errors
 * and bytes. Limit the raw response escape to explicitly declared streams. */
export function fetchStream<C extends RouteContract & { method: "GET"; kind: "stream" }>(contract: C, input: RouteInput<C>, sourceId: string, signal?: AbortSignal) {
  return sendRequest(routeUrl(contract, input, sourceId), { signal });
}
function sameWorkspaceRedirect(response: Response, requested: string) {
  try {
    const target = new URL(response.url), start = new URL(requested, location.href);
    const source = (path: string) => /^\/api\/agent-sources\/([^/]+)\//.exec(path)?.[1] ?? "";
    return response.ok && target.origin === start.origin && target.pathname.startsWith("/api/") &&
      source(target.pathname) === source(start.pathname);
  } catch { return false; }
}
async function requestInWorkspace<T>(path: string, sourceId: string, body?: unknown, method?: string, signal?: AbortSignal, kind?: "stream", multipart = false, empty = false, command?: Pick<Awaited<ReturnType<typeof prepareFleetCommand>>, "current" | "observe" | "dispatch"> & { headers?: Partial<Awaited<ReturnType<typeof prepareFleetCommand>>["headers"]> }): Promise<T> {
  const generation = viewGeneration();
  const requestId = ++clockRequestId;
  if (generation !== backoffGeneration) {
    readBackoff.clear();
    backoffGeneration = generation;
  }
  const url = sourceApiPathAt("/api" + path, sourceId);
  // Social and already-routed requests may have a different destination from
  // their caller's source. The cooldown belongs to the actual upstream.
  const destination = /^\/api\/agent-sources\/([^/]+)\//.exec(url)?.[1] ?? "";
  const verb = method || (body ? "POST" : "GET");
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  const until = readBackoff.get(destination) ?? 0;
  if (["GET", "HEAD"].includes(verb.toUpperCase()) && until > Date.now())
    throw limited(until);
  const r = await sendRequest(url, {
    signal,
    method: verb,
    headers: { ...(body && !multipart ? { "content-type": "application/json" } : {}), ...command?.headers },
    body: multipart ? body as FormData : body ? JSON.stringify(body) : undefined,
  }, command?.current, command?.dispatch).catch((error) => {
    if (error instanceof TypeError && !signal?.aborted)
      throw new Error(
        "Couldn’t reach Loop55. Check your connection and try again.",
      );
    throw error;
  });
  command?.current();
  command?.observe(r);
  // Rejected before forwarding, so it is safe to try again; the caller's
  // durable request key still reconciles anything sent earlier.
  if (restarting(r)) throw reconnectingError();
  let deadline: number | undefined;
  if (r.status === 429 && r.headers.has("retry-after")) {
    deadline = retryDeadline(r.headers.get("retry-after"));
    // A late response from a previous owner cannot throttle the new owner.
    if (generation === viewGeneration() && generation === backoffGeneration)
      readBackoff.set(destination, Math.max(readBackoff.get(destination) ?? 0, deadline));
    // A domain refusal may also use 429 (pending-run/catalog capacity). Keep
    // its actionable body; only an explicit header creates a read cooldown.
  }
  if (
    r.redirected &&
    !r.headers.get("content-type")?.includes("application/json") &&
    !(kind === "stream" && sameWorkspaceRedirect(r, url))
  ) {
    clearAuthorization();
    window.dispatchEvent(new Event("loop55-auth-expired"));
    throw Object.assign(new Error("Sign in to Loop55"), { redirected: true });
  }
  // Multipart callers previously named the HTTP status when a tunnel or proxy
  // returned an error page instead of Loop55's JSON receipt.
  const uploadFailure = `Upload failed (HTTP ${r.status}${r.statusText ? " " + r.statusText : ""}). Try again.`;
  let parsed = true;
  const data = await (empty && r.status === 204 ? Promise.resolve(undefined) : r.ok && kind === "stream" ? r.blob() : r.json()).catch(() => {
    parsed = false;
    return { error: multipart ? uploadFailure : "Connection unavailable. Try again." };
  });
  if (!r.ok || !parsed) {
    if (r.status === 401 && (!sourceId || /Pair this device/i.test(data?.error || ""))) {
      clearAuthorization();
      window.dispatchEvent(new Event("loop55-auth-expired"));
    }
    // The status lets callers tell a refusal (4xx) from an uncertain outcome.
    throw Object.assign(
      new Error(data?.error || data?.message || (multipart ? uploadFailure : "Request failed")),
      {
        status: parsed || r.status === 429 || r.status >= 500 ? r.status : undefined,
        ...(["refused", "unknown", "completed"].includes(data?.executionOutcome)
          ? { executionOutcome: data.executionOutcome } : {}),
        ...(deadline !== undefined ? { retryAt: deadline, retryAfterMs: Math.max(0, deadline - Date.now()) } : {}),
      },
    );
  }
  if (generation === viewGeneration() && verb.toUpperCase() === "GET" && r.headers.has("x-loop55-next-deadline")) {
    const next = r.headers.get("x-loop55-next-deadline");
    const clock = WorkspaceClock.safeParse({
      epoch: r.headers.get("x-loop55-change-epoch"),
      cursor: Number(r.headers.get("x-loop55-change-cursor")),
      serverNow: Number(r.headers.get("x-loop55-server-now")),
      nextDeadline: next === "null" ? null : Number(next),
    });
    if (clock.success) window.dispatchEvent(new CustomEvent("loop55-workspace-clock", {
      detail: { source: decodeURIComponent(destination), generation, requestId, clock: clock.data },
    }));
  }
  return data;
}

/** One-shot projections recover from cooldowns and at most two transient
 * server failures. Only GETs retry; view cancellation stops IO and waits. */
export type ReadMode = "automatic" | "manual";
async function readRequest<T>(path: string, sourceId: string, signal: AbortSignal, onRetry?: (error: unknown) => void, kind?: "stream", mode: ReadMode = "automatic"): Promise<T> {
  let failures = 0;
  for (;;) {
    try { return await requestInWorkspace<T>(path, sourceId, undefined, "GET", signal, kind); }
    catch (error) {
      if (signal.aborted) throw error;
      const status = (error as {status?:number}).status;
      const delay = isRateLimited(error) ? retryAfter(error) :
        mode === "automatic" && status && status >= 500 && status < 600 && failures < 2 ? 2000 * ++failures : undefined;
      if (delay === undefined) throw error;
      onRetry?.(error);
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        }, Math.min(2_147_483_647, Math.max(1000, delay)));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  }
}
export const parse = <T = any>(value: string | undefined, fallback: T): T => {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};

// Callers can keep their existing invalid-snapshot recovery policy without
// exposing validation details or treating malformed output as a transient GET.
export class UnavailableResponse extends Error {
  constructor() {
    super("The workspace returned an unavailable response. Refresh before trying again.");
    this.name = "UnavailableResponse";
  }
}

function response<C extends RouteContract>(contract: C, value: unknown): RouteResponse<C> {
  const parsed = contract.response.safeParse(value);
  if (!parsed.success) throw new UnavailableResponse();
  return parsed.data as RouteResponse<C>;
}
export async function callRoute<C extends ClientRouteContract>(contract: C, input: RouteInput<C>, sourceId: string, signal?: AbortSignal): Promise<RouteResponse<C>> {
  if ((contract as RouteContract).method === "ALL") throw new Error("Protocol dispatch requires a concrete HTTP method");
  const generation = viewGeneration();
  const path = routePath(contract, input);
  const routed = sourceApiPathAt("/api" + path, sourceId);
  const destination = decodeURIComponent(/^\/api\/agent-sources\/([^/]+)\//.exec(routed)?.[1] ?? "");
  const command = destination.startsWith("peer:") && contract.method !== "GET" && !isFleetReadContract(contract)
    ? await prepareFleetCommand(destination, contract, input, signal) : undefined;
  const perform = async () => {
    const guarded = {
      headers: command?.headers ?? {},
      current() {
        command?.current();
        if (generation !== viewGeneration()) throw new UnavailableResponse();
        signal?.throwIfAborted();
      },
      observe(r: Response) { command?.observe(r); },
      dispatch() { command?.dispatch(); },
    };
    try {
      let body: unknown = command?.body ?? input.body;
      if (contract.multipart && "file" in input) {
        // routePath validated the part before transport; conditional generic input
        // types do not narrow together with their contract's marker.
        const upload = input as RouteInput<C> & { file: Blob; filename?: string };
        const form = new FormData();
        if (command?.upload) {
          form.append("manifest", JSON.stringify(command.upload));
          // An unresolved upload only queries its receipt; do not send its bytes again.
          if (command.headers["x-loop55-receipt-only"] !== "1") form.append("file", upload.file, "upload");
        } else {
          for (const [key, value] of Object.entries(input.body ?? {}))
            if (value !== undefined) form.append(key, String(value));
          if (upload.filename === undefined) form.append("file", upload.file);
          else form.append("file", upload.file, upload.filename);
        }
        body = form;
      }
      const value = response(contract, await requestInWorkspace<unknown>(path, sourceId, body, contract.method, signal, contract.kind === "stream" ? "stream" : undefined, contract.multipart, contract.status === 204, guarded));
      guarded.current();
      await command?.settle(true);
      return value;
    } catch (error) {
      await command?.settle(false);
      if (command && error instanceof Error)
        Object.assign(error, { executionOutcome: command.executionOutcome });
      throw error;
    }
  };
  return command ? command.run(perform) : perform();
}
export async function readRoute<C extends RouteContract & { method: "GET" }>(contract: C, input: RouteInput<C>, sourceId: string, signal: AbortSignal, onRetry?: (error: unknown) => void, mode: ReadMode = "automatic"): Promise<RouteResponse<C>> {
  return response(contract, await readRequest<unknown>(routePath(contract, input), sourceId, signal, onRetry, contract.kind, mode));
}
