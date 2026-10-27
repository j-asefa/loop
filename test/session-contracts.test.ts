import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSessionCheck } from "../src/client/app/Session";
import { setShellSource } from "../src/client/sourceRouting";
import { setViewOwner } from "../src/client/viewCache";

const fetcher = vi.fn<typeof fetch>();
const setSession = vi.fn();
const reload = vi.fn();
const assign = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  setShellSource("");
  setViewOwner(undefined);
  setViewOwner("session-fixture");
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
  vi.stubGlobal("location", {
    href: "https://loop.test/?source=docker:one",
    reload,
    assign,
  });
});
afterEach(() => {
  setShellSource("");
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("loads only the typed session projection and accepts the account endpoint's absent mode", async () => {
  fetcher.mockResolvedValueOnce(
    Response.json({
      user: { id: "owner", name: "Owner", email: "private@example.com" },
      session: { token: "private" },
    }),
  );
  await createSessionCheck({ setSession })();
  expect(setSession).toHaveBeenCalledWith({
    user: { id: "owner", name: "Owner" },
    mode: "multi-user",
  });
  expect(fetcher.mock.calls[0][0]).toBe("/api/auth/get-session");
  expect(fetcher.mock.calls[0][1]).toMatchObject({
    method: "GET",
    cache: "no-store",
    credentials: "same-origin",
  });
});

it("keeps anonymous sessions null and rejects malformed identity data", async () => {
  fetcher.mockResolvedValueOnce(Response.json(null));
  const check = createSessionCheck({ setSession });
  await check();
  expect(setSession).toHaveBeenCalledWith(null);
  setSession.mockClear();
  fetcher.mockResolvedValueOnce(
    Response.json({ user: { id: 5, name: "Owner" } }),
  );
  await expect(check()).rejects.toThrow("unavailable response");
  expect(setSession).not.toHaveBeenCalled();
});

it("returns to the local source after a linked-source refusal and reloads proxy sign-in redirects", async () => {
  setShellSource("docker:one");
  fetcher.mockResolvedValueOnce(
    Response.json({ error: "Source sign-in needed" }, { status: 401 }),
  );
  await createSessionCheck({ setSession })();
  expect(fetcher.mock.calls[0][0]).toBe(
    "/api/agent-sources/docker%3Aone/auth/get-session",
  );
  expect(assign).toHaveBeenCalledWith("/");
  expect(setSession).not.toHaveBeenCalled();
  setShellSource("");
  const response = new Response("<html>Sign in</html>", {
    headers: { "content-type": "text/html" },
  });
  Object.defineProperty(response, "redirected", { value: true });
  fetcher.mockResolvedValueOnce(response);
  await createSessionCheck({ setSession })();
  expect(reload).toHaveBeenCalledTimes(1);
  expect(setSession).not.toHaveBeenCalled();
});

it("recovers a transient session read and cancels its pending recovery with the view", async () => {
  fetcher.mockResolvedValueOnce(
    Response.json({ error: "Unavailable" }, { status: 503 }),
  );
  fetcher.mockResolvedValueOnce(
    Response.json({
      user: { id: "owner", name: "Owner" },
      mode: "single-user",
    }),
  );
  const check = createSessionCheck({ setSession });
  const recovery = check();
  await vi.advanceTimersByTimeAsync(2000);
  await recovery;
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(setSession).toHaveBeenCalledWith({
    user: { id: "owner", name: "Owner" },
    mode: "single-user",
  });
  fetcher.mockClear();
  setSession.mockClear();
  fetcher.mockResolvedValueOnce(
    Response.json({ error: "Unavailable" }, { status: 503 }),
  );
  const controller = new AbortController();
  const pending = check(controller.signal).catch((error) => error);
  await vi.advanceTimersByTimeAsync(0);
  controller.abort();
  expect((await pending).name).toBe("AbortError");
  await vi.advanceTimersByTimeAsync(5000);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(setSession).not.toHaveBeenCalled();
});
