import { capabilities } from "./capabilities";
import { executionSourceId, sourceApiPathAt } from "./sourceRouting";
let csrf = "";
let sessionRequest: Promise<void> | undefined;
export async function authorize() {
  if ((!capabilities.pairedDevices && !executionSourceId()) || csrf) return;
  if (!sessionRequest)
    sessionRequest = (async () => {
      const response = await fetch("/session", {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!response.ok) {
        window.dispatchEvent(new Event("loop-auth-expired"));
        throw new Error("Pair this device from the desktop.");
      }
      csrf = (await response.json()).csrf;
    })().finally(() => {
      sessionRequest = undefined;
    });
  await sessionRequest;
}
export function clearAuthorization() {
  csrf = "";
}
export async function authorizedFetch(path: string, init: RequestInit = {}) {
  const method = init.method || "GET";
  const headers = new Headers(init.headers);
  if (!["GET", "HEAD"].includes(method.toUpperCase())) {
    await authorize();
    headers.set("x-loop-csrf", csrf);
  }
  return fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
    cache: "no-store",
  });
}
export async function api<T = any>(
  path: string,
  body?: unknown,
  method?: string,
  signal?: AbortSignal,
): Promise<T> {
  return apiInWorkspace(path, executionSourceId(), body, method, signal);
}

export async function apiInWorkspace<T = any>(
  path: string,
  sourceId: string,
  body?: unknown,
  method?: string,
  signal?: AbortSignal,
): Promise<T> {
  const r = await authorizedFetch(sourceApiPathAt("/api" + path, sourceId), {
    signal,
    method: method || (body ? "POST" : "GET"),
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).catch((error) => {
    if (error instanceof TypeError && !signal?.aborted)
      throw new Error(
        "Couldn’t reach Loop. Check your connection and try again.",
      );
    throw error;
  });
  if (
    r.redirected &&
    !r.headers.get("content-type")?.includes("application/json")
  ) {
    clearAuthorization();
    window.dispatchEvent(new Event("loop-auth-expired"));
    throw new Error("Sign in to Loop");
  }
  let parsed = true;
  const data = await r.json().catch(() => {
    parsed = false;
    return { error: "Connection unavailable. Try again." };
  });
  if (!r.ok || !parsed) {
    if (r.status === 401 && (!sourceId || /Pair this device/i.test(data?.error || ""))) {
      clearAuthorization();
      window.dispatchEvent(new Event("loop-auth-expired"));
    }
    // The status lets callers tell a refusal (4xx) from an uncertain outcome.
    throw Object.assign(
      new Error(data?.error || data?.message || "Request failed"),
      { status: parsed ? r.status : undefined },
    );
  }
  return data;
}
export const parse = <T = any>(value: string | undefined, fallback: T): T => {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};
