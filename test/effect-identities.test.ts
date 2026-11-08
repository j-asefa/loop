import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { performStoredEffect } from "../src/client/durableIdentities";
import {
  recentSearches,
  rememberSearch,
  clearRecentSearches,
  lastVisit,
  recordVisit,
} from "../src/client/deviceHistory";

let storage: Storage;
beforeEach(() => {
  const values = new Map<string, string>();
  storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
  vi.stubGlobal("localStorage", storage);
  const tails = new Map<string, Promise<unknown>>();
  vi.stubGlobal("navigator", {
    locks: {
      request(key: string, apply: () => unknown) {
        const next = (tails.get(key) ?? Promise.resolve()).then(apply);
        tails.set(
          key,
          next.catch(() => {}),
        );
        return next;
      },
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

const refused = () =>
  Object.assign(new Error("Refused"), {
    executionOutcome: "refused",
    status: 422,
  });
const unknown = () =>
  Object.assign(new Error("Unknown"), {
    executionOutcome: "unknown",
    status: 409,
  });

it("retains an uncertain effect across attempts and settles only explicit outcomes", async () => {
  const ids: string[] = [];
  const send = (failure?: Error) =>
    performStoredEffect(
      storage,
      "alice",
      "",
      ["provider-refresh", "pi", "project"],
      () => true,
      async (id) => {
        ids.push(id);
        if (failure) throw failure;
        return "accepted";
      },
    );
  await expect(send(new Error("Timeout"))).rejects.toThrow("Timeout");
  await expect(send(unknown())).rejects.toThrow("Unknown");
  expect(ids[1]).toBe(ids[0]);
  await expect(send()).resolves.toBe("accepted");
  expect(ids[2]).toBe(ids[0]);
  await expect(send(refused())).rejects.toThrow("Refused");
  expect(ids[3]).not.toBe(ids[0]);
  await send();
  expect(ids[4]).not.toBe(ids[3]);
  expect(storage.length).toBe(0);
});

it("a late refusal cannot clear a newer uncertain attempt of the same command", async () => {
  const ids: string[] = [];
  let failFirst!: (reason: Error) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const first = performStoredEffect(
    storage,
    "alice",
    "",
    ["provider-key", "pi"],
    () => true,
    (id) => {
      ids.push(id);
      entered();
      return new Promise<never>((_resolve, reject) => {
        failFirst = reject;
      });
    },
  );
  const firstResult = expect(first).rejects.toThrow("Refused");
  await started;
  await expect(
    performStoredEffect(
      storage,
      "alice",
      "",
      ["provider-key", "pi"],
      () => true,
      async (id) => {
        ids.push(id);
        throw unknown();
      },
    ),
  ).rejects.toThrow("Unknown");
  failFirst(refused());
  await firstResult;
  await performStoredEffect(
    storage,
    "alice",
    "",
    ["provider-key", "pi"],
    () => true,
    async (id) => {
      ids.push(id);
    },
  );
  expect(ids).toHaveLength(3);
  expect(new Set(ids).size).toBe(1);
});

it.each(["getItem", "setItem"] as const)(
  "refuses dispatch when storage %s fails",
  async (method) => {
    const dispatch = vi.fn(async () => "accepted");
    storage[method] = () => {
      throw new Error("Storage unavailable");
    };
    await expect(
      performStoredEffect(
        storage,
        "alice",
        "",
        ["artifact-refresh", "a"],
        () => true,
        dispatch,
      ),
    ).rejects.toThrow("nothing was sent");
    expect(dispatch).not.toHaveBeenCalled();
  },
);

it("refuses a view replaced while preparation waited for its lock", async () => {
  let current = true;
  const dispatch = vi.fn(async () => "accepted");
  const request = performStoredEffect(
    storage,
    "alice",
    "",
    ["artifact-refresh", "a"],
    () => current,
    dispatch,
  );
  current = false;
  await expect(request).rejects.toThrow("view has changed");
  expect(dispatch).not.toHaveBeenCalled();
  expect(storage.length).toBe(0);
});

it("separates device history by owner and never reads unscoped keys", () => {
  storage.setItem("loop-recent-searches", JSON.stringify(["Earlier build"]));
  storage.setItem("loop-last-visit", "10");
  expect(recentSearches("alice")).toEqual([]);
  expect(lastVisit("alice")).toBe(0);
  rememberSearch("alice", "Private query");
  recordVisit("alice", 100);
  expect(recentSearches("bob")).toEqual([]);
  expect(lastVisit("bob")).toBe(0);
  rememberSearch("bob", "Other query");
  recordVisit("bob", 200);
  clearRecentSearches("bob");
  expect(recentSearches("alice")).toEqual(["Private query"]);
  expect(recentSearches("bob")).toEqual([]);
  expect(lastVisit("alice")).toBe(100);
  expect(lastVisit("bob")).toBe(200);
  const count = storage.length;
  rememberSearch(undefined, "Signed out");
  recordVisit(undefined, 300);
  clearRecentSearches(undefined);
  expect(recentSearches(undefined)).toEqual([]);
  expect(lastVisit(undefined)).toBe(0);
  expect(storage.length).toBe(count);
});
