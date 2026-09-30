import { afterEach, expect, it, vi } from "vitest";
import { api } from "../src/client/api";
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
