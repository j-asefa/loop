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
