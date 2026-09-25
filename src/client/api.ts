export async function api<T = any>(
  path: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const r = await fetch("/api" + path, {
    method: method || (body ? "POST" : "GET"),
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  if (
    r.redirected &&
    !r.headers.get("content-type")?.includes("application/json")
  ) {
    window.dispatchEvent(new Event("loop-auth-expired"));
    throw new Error("Sign in to continue.");
  }
  const data = await r
    .json()
    .catch(() => ({ error: "Connection unavailable. Try again." }));
  if (!r.ok) {
    if (r.status === 401) window.dispatchEvent(new Event("loop-auth-expired"));
    throw new Error(data.error || data.message || "Request failed");
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
