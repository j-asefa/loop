import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, apiInWorkspace, authorizedFetch, readInWorkspace } from "../src/client/api";
import { legacyFilePath } from "../src/client/legacy-paths";
beforeEach(() => vi.stubGlobal("location", { search: "" }));
afterEach(() => vi.unstubAllGlobals());
it("fetches only named download paths from serialized file responses", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response("file"));
  vi.stubGlobal("fetch", fetcher);
  await authorizedFetch(legacyFilePath("/api/agent-sources/docker%3Aone/artifacts/artifact/file"));
  expect(fetcher.mock.calls[0][0]).toBe("/api/agent-sources/docker%3Aone/artifacts/artifact/file");
  expect(() => legacyFilePath("/api/unlisted")).toThrow("File address is unavailable");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

// The compiler enforces the transport boundary; these calls are never run.
function pathTypes(path: string, signal: AbortSignal) {
  // @ts-expect-error Raw strings require a contract or a named legacy path.
  api(path);
  // @ts-expect-error Source routing cannot widen the legacy path boundary.
  apiInWorkspace(path, "");
  // @ts-expect-error Retrying reads use the same named paths.
  readInWorkspace(path, "", signal);
  // @ts-expect-error Authenticated fetch cannot bypass the named list.
  authorizedFetch(path);
  // @ts-expect-error Already-typed routes must use callRoute/readRoute.
  api("/bootstrap");
}
it("returns server proxy redirects to the auth screen", async () => {
  const dispatchEvent = vi.fn();
  vi.stubGlobal("window", { dispatchEvent });
  const response = new Response("<html>Sign in</html>", {
    headers: { "content-type": "text/html" },
  });
  Object.defineProperty(response, "redirected", { value: true });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
  await expect(api("/artifacts")).rejects.toThrow("Sign in to Loop");
  expect(dispatchEvent.mock.calls[0][0].type).toBe("loop-auth-expired");
});
it("accepts JSON responses after a redirect", async () => {
  const response = Response.json({ ok: true });
  Object.defineProperty(response, "redirected", { value: true });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
  await expect(api("/artifacts")).resolves.toEqual({ ok: true });
});
it("keeps Social on the paired app while an agent source owns its conversations", async () => {
  const id = "a".repeat(64);
  vi.stubGlobal("location", { search: `?source=docker:${id}` });
  const fetcher = vi
    .fn()
    .mockImplementation((path: string) =>
      Promise.resolve(
        Response.json(path === "/session" ? { csrf: "fixture" } : { ok: true }),
      ),
    );
  vi.stubGlobal("fetch", fetcher);
  await api("/social");
  await api("/social/feeds");
  await api("/social/feeds/hackernews", undefined, "PUT");
  await api("/artifacts");
  expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
    "/api/social",
    "/api/social/feeds",
    "/session",
    "/api/social/feeds/hackernews",
    `/api/agent-sources/docker%3A${id}/artifacts`,
  ]);
});
it("opens old workspace links through the source route", async () => {
  const id = "b".repeat(64);
  vi.stubGlobal("location", { search: `?workspace=docker:${id}` });
  const fetcher = vi.fn().mockResolvedValue(Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetcher);
  await api("/conversations/old-thread/usage");
  expect(fetcher.mock.calls[0][0]).toBe(
    `/api/agent-sources/docker%3A${id}/conversations/old-thread/usage`,
  );
});
it("keeps the paired session when one source refuses authentication", async () => {
  const dispatchEvent = vi.fn();
  vi.stubGlobal("window", { dispatchEvent });
  vi.stubGlobal("location", { search: `?source=docker:${"c".repeat(64)}` });
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ error: "Source sign-in needed" }, { status: 401 }),
      ),
  );
  await expect(api("/artifacts")).rejects.toThrow("Source sign-in needed");
  expect(dispatchEvent).not.toHaveBeenCalled();
});
it.each(["truncated", "interrupted"])(
  "rejects a %s success response instead of returning it as workspace data",
  async (failure) => {
    const response = new Response('{"agents":', {
      headers: { "content-type": "application/json" },
    });
    if (failure === "interrupted")
      vi.spyOn(response, "json").mockRejectedValue(
        new DOMException("Body stream aborted", "AbortError"),
      );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(api("/artifacts")).rejects.toThrow(
      "Connection unavailable. Try again.",
    );
  },
);
it("still expires the session when an unauthorized response has no JSON body", async () => {
  const dispatchEvent = vi.fn();
  vi.stubGlobal("window", { dispatchEvent });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 })),
  );
  await expect(api("/artifacts")).rejects.toThrow(
    "Connection unavailable. Try again.",
  );
  expect(dispatchEvent.mock.calls[0][0].type).toBe("loop-auth-expired");
});
const restarting = () =>
  Response.json(
    { error: "Loop is restarting. Try again in a moment.", reconnecting: true },
    { status: 503, headers: { "x-loop-unavailable": "restarting" } },
  );
it("treats the connection service's restart response as reconnecting, never as signed out", async () => {
  const dispatchEvent = vi.fn();
  vi.stubGlobal("window", { dispatchEvent });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(restarting()));
  const error = await api("/artifacts").catch((e) => e);
  expect(error).toMatchObject({ status: 503, reconnecting: true });
  expect(error.message).toMatch(/reconnecting/);
  const events = dispatchEvent.mock.calls.map(([event]) => event.type);
  expect(events).toEqual(["loop-reconnecting"]);
});
it("keeps a mutation's session and outcome uncertain while Loop restarts", async () => {
  const dispatchEvent = vi.fn();
  vi.stubGlobal("window", { dispatchEvent });
  vi.stubGlobal("location", { search: "" });
  // One attempt: the client never resends on its own.
  const fetcher = vi.fn().mockResolvedValue(restarting());
  vi.stubGlobal("fetch", fetcher);
  const error = await api("/artifacts", { input: "x" }).catch((e) => e);
  expect(error.status).toBe(503);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(dispatchEvent.mock.calls.map(([event]) => event.type)).not.toContain(
    "loop-auth-expired",
  );
});
