import { beforeEach, expect, it } from "vitest";

// A Map-backed localStorage stands in for the browser's per-device storage.
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
};
const { GLOBAL_DRAFT, saveThreadDraft, setDraftOwner, threadDraft } =
  await import("../src/client/drafts");

beforeEach(() => {
  store.clear();
  setDraftOwner(undefined);
});

it("keeps each account's unsent drafts private on a shared device", () => {
  setDraftOwner("alice");
  saveThreadDraft(GLOBAL_DRAFT, "Alice's private idea", [{ id: "f1" }]);
  saveThreadDraft("thread-1", "Alice's reply", []);
  expect(threadDraft(GLOBAL_DRAFT)).toEqual({
    text: "Alice's private idea",
    files: [{ id: "f1" }],
  });
  // Session expiry or sign-out: no owner, so nothing is read or written.
  setDraftOwner(undefined);
  expect(threadDraft(GLOBAL_DRAFT)).toEqual({ text: "", files: [] });
  saveThreadDraft(GLOBAL_DRAFT, "", []);
  saveThreadDraft("thread-1", "", []);
  // Another account signs in on the same device.
  setDraftOwner("bob");
  expect(threadDraft(GLOBAL_DRAFT)).toEqual({ text: "", files: [] });
  expect(threadDraft("thread-1").text).toBe("");
  saveThreadDraft(GLOBAL_DRAFT, "Bob's draft", []);
  // Alice's drafts survived the switch untouched and stay hers.
  setDraftOwner("alice");
  expect(threadDraft(GLOBAL_DRAFT).text).toBe("Alice's private idea");
  expect(threadDraft("thread-1").text).toBe("Alice's reply");
  expect(threadDraft(GLOBAL_DRAFT, "bob").text).toBe("Bob's draft");
});

it("clears a thread draft when its text and files are emptied", () => {
  setDraftOwner("alice");
  saveThreadDraft("thread-2", "Draft", [{ id: "f" }]);
  saveThreadDraft("thread-2", "  ", []);
  expect(threadDraft("thread-2")).toEqual({ text: "", files: [] });
  expect(store.size).toBe(0);
});
