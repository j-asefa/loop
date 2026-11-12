import { beforeEach, expect, it } from "vitest";

// A Map-backed localStorage stands in for the browser's per-device storage.
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
};
const {
  sourceDraftId,
  clearAcceptedDraft,
  GLOBAL_DRAFT,
  saveThreadDraft,
  setDraftOwner,
  threadDraft,
} = await import("../src/client/drafts");

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

it("isolates text and attachments for identical conversation IDs on different sources", () => {
  setDraftOwner("alice");
  saveThreadDraft(sourceDraftId("same", ""), "Laptop", [{ id: "local-file" }]);
  saveThreadDraft(sourceDraftId("same", "docker:alpha"), "Docker", [
    { id: "remote-file" },
  ]);
  expect(threadDraft(sourceDraftId("same", ""))).toEqual({
    text: "Laptop",
    files: [{ id: "local-file" }],
  });
  expect(threadDraft(sourceDraftId("same", "docker:alpha"))).toEqual({
    text: "Docker",
    files: [{ id: "remote-file" }],
  });
  expect(threadDraft(sourceDraftId("same", "docker:beta"))).toEqual({
    text: "",
    files: [],
  });
  setDraftOwner("bob");
  expect(threadDraft(sourceDraftId("same", "docker:alpha")).text).toBe("");
});

it("settles the original global draft after navigation without clearing newer drafts or another owner", () => {
  setDraftOwner("alice");
  const origin = sourceDraftId(GLOBAL_DRAFT, "docker:alpha");
  saveThreadDraft(origin, "Sent to the existing manager thread", [
    { id: "file" },
  ]);
  saveThreadDraft("resolved-thread", "Different thread draft", []);
  setDraftOwner("bob");
  saveThreadDraft(origin, "Bob's draft", []);
  clearAcceptedDraft(
    origin,
    "Sent to the existing manager thread",
    [{ id: "file" }],
    "alice",
  );
  expect(threadDraft(origin, "alice").text).toBe("");
  expect(threadDraft("resolved-thread", "alice").text).toBe(
    "Different thread draft",
  );
  expect(threadDraft(origin).text).toBe("Bob's draft");
  saveThreadDraft(origin, "Newer Alice draft", [], "alice");
  clearAcceptedDraft(
    origin,
    "Sent to the existing manager thread",
    [{ id: "file" }],
    "alice",
  );
  expect(threadDraft(origin, "alice").text).toBe("Newer Alice draft");
});

it("keeps a local thread whose ID resembles a remote key separate from that remote draft", () => {
  setDraftOwner("alice");
  const remote = sourceDraftId("same", "docker:alpha");
  const local = sourceDraftId(remote, "");
  saveThreadDraft(remote, "Remote draft", []);
  saveThreadDraft(local, "Local draft", []);
  expect(threadDraft(remote).text).toBe("Remote draft");
  expect(threadDraft(local).text).toBe("Local draft");
});

it("keeps draft reads and writes optional when local storage access is denied", () => {
  setDraftOwner("alice");
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new Error("Storage denied");
    },
  });
  try {
    expect(threadDraft("thread")).toEqual({ text: "", files: [] });
    expect(() => saveThreadDraft("thread", "in-memory", [])).not.toThrow();
  } finally {
    Object.defineProperty(globalThis, "localStorage", original);
  }
});
