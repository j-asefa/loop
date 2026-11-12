import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sessionDraft } from "../src/client/workspace-drafts";
import { setViewOwner } from "../src/client/viewCache";

const values = new Map<string, string>();
beforeEach(() => {
  values.clear();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  setViewOwner(undefined);
});
afterEach(() => vi.unstubAllGlobals());

it.each(["loop"])(
  "qualifies saved choices without attributing unowned %s drafts",
  (prefix) => {
    values.set(`${prefix}-draft-agent`, "unattributed-agent");
    values.set(
      `${prefix}-share`,
      JSON.stringify({ excerpt: "unattributed-private" }),
    );
    setViewOwner("alice");
    const a = sessionDraft<string>("alice", "peer:a", "agent-tab", "same-id");
    const b = sessionDraft<string>("alice", "peer:b", "agent-tab", "same-id");
    a.write("files");
    b.write("traces");
    expect(a.read()).toBe("files");
    expect(b.read()).toBe("traces");
    expect(sessionDraft("alice", "peer:a", "composer").read()).toBeUndefined();
    expect(sessionDraft("alice", "peer:a", "share").read()).toBeUndefined();
    setViewOwner("bob");
    expect(
      sessionDraft("bob", "peer:a", "agent-tab", "same-id").read(),
    ).toBeUndefined();
    expect(a.read()).toBeUndefined();
  },
);

it("an old callback cannot overwrite a returning owner's new draft", () => {
  setViewOwner("alice");
  const old = sessionDraft<string>("alice", "peer:a", "share");
  old.write("private draft");
  setViewOwner(undefined);
  old.write("signed out");
  setViewOwner("alice");
  const current = sessionDraft<string>("alice", "peer:a", "share");
  expect(current.read()).toBe("private draft");
  current.write("new draft");
  old.write("late callback");
  expect(current.read()).toBe("new draft");
});

it("keeps session draft failures optional, including unavailable storage access", () => {
  setViewOwner("alice");
  const draft = sessionDraft<string>("alice", "", "composer");
  values.set(draft.key, "{");
  expect(draft.read()).toBeUndefined();
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    get() {
      throw new Error("Storage denied");
    },
  });
  expect(draft.read()).toBeUndefined();
  expect(() => draft.write("in-memory draft")).not.toThrow();
});
