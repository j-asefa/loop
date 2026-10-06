import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../src/client/api";
beforeEach(() => vi.stubGlobal("location", { search: "" }));
afterEach(() => vi.unstubAllGlobals());
it("returns server proxy redirects to the auth screen", async () => {
  const dispatchEvent = vi.fn();
  vi.stubGlobal("window", { dispatchEvent });
  const response = new Response("<html>Sign in</html>", {
    headers: { "content-type": "text/html" },
  });
  Object.defineProperty(response, "redirected", { value: true });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
  await expect(api("/agents")).rejects.toThrow("Sign in to Loop");
  expect(dispatchEvent.mock.calls[0][0].type).toBe("loop-auth-expired");
});
it("accepts JSON responses after a redirect", async () => {
  const response = Response.json({ ok: true });
  Object.defineProperty(response, "redirected", { value: true });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
  await expect(api("/agents")).resolves.toEqual({ ok: true });
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
  await api("/conversations");
  expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
    "/api/social",
    "/api/social/feeds",
    "/session",
    "/api/social/feeds/hackernews",
    `/api/agent-sources/docker%3A${id}/conversations`,
  ]);
});
it("opens old workspace links through the source route", async () => {
  const id = "b".repeat(64);
  vi.stubGlobal("location", { search: `?workspace=docker:${id}` });
  const fetcher = vi.fn().mockResolvedValue(Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetcher);
  await api("/conversations/old-thread");
  expect(fetcher.mock.calls[0][0]).toBe(
    `/api/agent-sources/docker%3A${id}/conversations/old-thread`,
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
  await expect(api("/bootstrap")).rejects.toThrow("Source sign-in needed");
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
    await expect(api("/bootstrap")).rejects.toThrow(
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
  await expect(api("/bootstrap")).rejects.toThrow(
    "Connection unavailable. Try again.",
  );
  expect(dispatchEvent.mock.calls[0][0].type).toBe("loop-auth-expired");
});
