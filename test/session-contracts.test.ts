import { OwnerId } from "../src/shared/contract-ids.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSessionCheck } from "../src/client/app/Session";
import { setShellSource } from "../src/client/sourceRouting";
import { setViewOwner } from "../src/client/viewCache";
import { ownerSession } from "../src/client/ownerSession";

const fetcher = vi.fn<typeof fetch>();
const setSession = vi.fn();
const reload = vi.fn();
const assign = vi.fn();
const replaceState = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  setShellSource("");
  setViewOwner(undefined);
  setViewOwner("session-fixture");
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
  vi.stubGlobal("history", { replaceState });
  vi.stubGlobal("location", {
    href: "https://loop.test/?source=docker:one",
    reload,
    assign,
  });
});

it.each(["pair", "fleet"])(
  "discards a %s link when an existing device session bypasses pairing",
  async (kind) => {
    vi.stubGlobal("location", {
      href: `https://loop.test/?page=feed#${kind}=one-time-capability`,
    });
    fetcher.mockResolvedValueOnce(
      Response.json({ user: { id: "owner", name: "Owner" }, mode: "paired" }),
    );
    await createSessionCheck({ setSession })();
    expect(replaceState).toHaveBeenCalledWith(null, "", "/?page=feed");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]?.method).toBe("GET");
  },
);

it("preserves anonymous pairing and unrelated shared fragments for their owning flow", async () => {
  vi.stubGlobal("location", { href: "https://loop.test/#fleet=capability" });
  fetcher.mockResolvedValueOnce(Response.json(null));
  await createSessionCheck({ setSession })();
  expect(replaceState).not.toHaveBeenCalled();
  vi.stubGlobal("location", {
    href: "https://loop.test/#share=shared-content",
  });
  fetcher.mockResolvedValueOnce(
    Response.json({ user: { id: "owner", name: "Owner" }, mode: "paired" }),
  );
  await createSessionCheck({ setSession })();
  expect(replaceState).not.toHaveBeenCalled();
});
afterEach(() => {
  setShellSource("");
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("loads only the typed paired session projection", async () => {
  fetcher.mockResolvedValueOnce(
    Response.json({
      user: { id: "owner", name: "Owner", email: "private@example.com" },
      mode: "paired",
      session: { token: "private" },
    }),
  );
  await createSessionCheck({ setSession })();
  expect(setSession).toHaveBeenCalledWith({
    user: { id: "owner", name: "Owner" },
    mode: "paired",
  });
  expect(fetcher.mock.calls[0][0]).toBe("/api/auth/get-session");
  expect(fetcher.mock.calls[0][1]).toMatchObject({
    method: "GET",
    cache: "no-store",
    credentials: "same-origin",
  });
});

it.each([
  "another owner",
  "expiry",
  "returning owner",
  "updated identity",
  "anonymous expiry",
])("does not replace %s with a delayed session response", async (change) => {
  vi.stubGlobal("location", {
    href: "https://loop.test/#pair=current-capability",
  });
  const alice = {
    user: { id: OwnerId.parse("alice"), name: "Alice" },
    mode: "paired" as const,
  };
  ownerSession.setSession(change === "anonymous expiry" ? undefined : alice);
  let finish!: (response: Response) => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = createSessionCheck({ setSession: ownerSession.setSession })();
  await vi.advanceTimersByTimeAsync(0);
  expect(fetcher).toHaveBeenCalledTimes(1);
  if (change === "another owner" || change === "returning owner") {
    ownerSession.setSession({
      user: { id: OwnerId.parse("bob"), name: "Bob" },
      mode: "paired",
    });
    if (change === "returning owner")
      ownerSession.setSession({
        ...alice,
        user: { ...alice.user, name: "Returned Alice" },
      });
  } else if (change === "updated identity") {
    ownerSession.setSession({
      ...alice,
      user: { ...alice.user, name: "Updated Alice" },
    });
  } else ownerSession.setSession(null);
  const current = ownerSession.current;
  finish(Response.json(alice));
  await pending;
  expect(ownerSession.current).toEqual(current);
  expect(replaceState).not.toHaveBeenCalled();
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
      mode: "paired",
    }),
  );
  const check = createSessionCheck({ setSession });
  const recovery = check();
  await vi.advanceTimersByTimeAsync(2000);
  await recovery;
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(setSession).toHaveBeenCalledWith({
    user: { id: "owner", name: "Owner" },
    mode: "paired",
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

it.each([
  ["startup", "redirect"],
  ["startup", "source"],
  ["paired", "redirect"],
  ["paired", "source"],
] as const)(
  "recovers %s %s failure after its expiry event",
  async (state, kind) => {
    const alice = {
      user: { id: OwnerId.parse("alice"), name: "Alice" },
      mode: "paired" as const,
    };
    ownerSession.setSession(state === "startup" ? undefined : alice);
    const target = new EventTarget();
    target.addEventListener("loop-auth-expired", () =>
      ownerSession.setSession(null),
    );
    vi.stubGlobal("window", target);
    setShellSource(kind === "source" ? "docker:one" : "");
    const response =
      kind === "source"
        ? Response.json({ error: "Pair this device" }, { status: 401 })
        : new Response("Sign in", { headers: { "content-type": "text/html" } });
    if (kind === "redirect")
      Object.defineProperty(response, "redirected", { value: true });
    fetcher.mockResolvedValueOnce(response);
    await createSessionCheck({ setSession: ownerSession.setSession })();
    expect(ownerSession.current.session).toBeNull();
    if (kind === "redirect") expect(reload).toHaveBeenCalledTimes(1);
    else expect(assign).toHaveBeenCalledWith("/");
  },
);

it.each(["redirect", "source"])(
  "does not recover an old %s failure after another owner replaces its expiry",
  async (kind) => {
    ownerSession.setSession({
      user: { id: OwnerId.parse("alice"), name: "Alice" },
      mode: "paired",
    });
    const target = new EventTarget();
    target.addEventListener("loop-auth-expired", () => {
      ownerSession.setSession(null);
      void Promise.resolve().then(() =>
        ownerSession.setSession({
          user: { id: OwnerId.parse("bob"), name: "Bob" },
          mode: "paired",
        }),
      );
    });
    vi.stubGlobal("window", target);
    setShellSource(kind === "source" ? "docker:one" : "");
    const response =
      kind === "source"
        ? Response.json({ error: "Pair this device" }, { status: 401 })
        : new Response("Sign in", { headers: { "content-type": "text/html" } });
    if (kind === "redirect")
      Object.defineProperty(response, "redirected", { value: true });
    fetcher.mockResolvedValueOnce(response);
    await createSessionCheck({ setSession: ownerSession.setSession })();
    expect(ownerSession.current.owner).toBe("bob");
    expect(reload).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  },
);
