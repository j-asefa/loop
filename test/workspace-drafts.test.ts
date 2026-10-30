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

it.each(["loop", "loop55"])(
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
