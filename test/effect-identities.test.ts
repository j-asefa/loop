import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  performStoredEffect,
  settleStoredEffect,
  UncertainEffect,
} from "../src/client/pendingCommands";
import {
  recentSearches,
  rememberSearch,
  clearRecentSearches,
  lastVisit,
  recordVisit,
  lastRecipient,
  rememberRecipient,
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

it("only explicit recovery supersedes an unknown identity and preserves its history", async () => {
  const ids: string[] = [];
  const send = () =>
    performStoredEffect(
      storage,
      "alice",
      "source",
      ["provider-refresh"],
      () => true,
      async (id) => {
        ids.push(id);
        throw unknown();
      },
    );
  await expect(send()).rejects.toThrow("Unknown");
  const failure = await send().catch((error) => error as UncertainEffect);
  expect(failure).toBeInstanceOf(UncertainEffect);
  expect(ids[1]).toBe(ids[0]);
  await failure.supersede();
  expect(ids).toHaveLength(2);
  const history = JSON.parse(
    storage.getItem(
      `loop-effect-history:${JSON.stringify(["alice", "source", ids[0]])}`,
    )!,
  );
  expect(history.commandId).toBe(ids[0]);
  await expect(send()).rejects.toThrow("Unknown");
  expect(ids[2]).not.toBe(ids[0]);
});

it("cannot supersede a newer attempt or a replaced owner view", async () => {
  let current = true;
  const send = () =>
    performStoredEffect(
      storage,
      "alice",
      "",
      ["provider-remove"],
      () => current,
      async () => {
        throw unknown();
      },
    ).catch((error) => error as UncertainEffect);
  const old = await send();
  const latest = await send();
  await expect(old.supersede()).rejects.toThrow("pending change has changed");
  current = false;
  await expect(latest.supersede()).rejects.toThrow("view has changed");
  expect(storage.length).toBe(1);
});

it("keeps the pending identity when preserving recovery history fails", async () => {
  const ids: string[] = [];
  const send = () =>
    performStoredEffect(
      storage,
      "alice",
      "",
      ["provider-key"],
      () => true,
      async (id) => {
        ids.push(id);
        throw unknown();
      },
    ).catch((error) => error as UncertainEffect);
  const failure = await send();
  const save = storage.setItem;
  storage.setItem = () => {
    throw new Error("Storage full");
  };
  await expect(failure.supersede()).rejects.toThrow("Storage full");
  storage.setItem = save;
  await send();
  expect(ids[1]).toBe(ids[0]);
});

it("refuses dispatch for a malformed pending record", async () => {
  storage.setItem(
    `loop-effect:${JSON.stringify(["alice", "", "provider-refresh"])}`,
    "{broken",
  );
  const dispatch = vi.fn(async () => "accepted");
  await expect(
    performStoredEffect(
      storage,
      "alice",
      "",
      ["provider-refresh"],
      () => true,
      dispatch,
    ),
  ).rejects.toThrow("Cannot read pending changes");
  expect(dispatch).not.toHaveBeenCalled();
});

it("retains the identity when settled-receipt removal fails", async () => {
  const ids: string[] = [];
  storage.removeItem = () => {
    throw new Error("Storage unavailable");
  };
  const send = () =>
    performStoredEffect(
      storage,
      "alice",
      "",
      ["provider-refresh"],
      () => true,
      async (id) => {
        ids.push(id);
        return "accepted";
      },
    );
  await expect(send()).resolves.toBe("accepted");
  await expect(send()).resolves.toBe("accepted");
  expect(ids[1]).toBe(ids[0]);
});

it("scopes run retry commands by owner, source and run, including the local source", async () => {
  const seen: string[] = [];
  const retry = (owner: string | undefined, source: string, run: string) =>
    performStoredEffect(
      storage,
      owner,
      source,
      ["run-retry", run],
      () => true,
      async (id) => {
        seen.push(id);
        throw new Error("Lost reply");
      },
    );
  await expect(retry("alice", "", "run-1")).rejects.toThrow("Lost reply");
  await expect(retry("alice", "", "run-1")).rejects.toThrow("Lost reply");
  expect(seen[1]).toBe(seen[0]);
  for (const [owner, source, run] of [
    ["bob", "", "run-1"],
    ["alice", "remote", "run-1"],
    ["alice", "", "run-2"],
  ])
    await expect(retry(owner, source, run)).rejects.toThrow("Lost reply");
  expect(new Set(seen).size).toBe(4);
  await expect(retry(undefined, "", "run-1")).rejects.toThrow("Sign in");
  expect(seen).toHaveLength(5);
});

it("settles observed upgrade commands only in the matching owner/source/runtime slot", async () => {
  const ids: string[] = [];
  const start = () =>
    performStoredEffect(
      storage,
      "alice",
      "",
      ["runtime-upgrade", "codex"],
      () => true,
      async (id) => {
        ids.push(id);
        throw new Error("Lost reply");
      },
    );
  await expect(start()).rejects.toThrow("Lost reply");
  for (const [owner, source, runtime, id] of [
    ["bob", "", "codex", ids[0]],
    ["alice", "remote", "codex", ids[0]],
    ["alice", "", "pi", ids[0]],
    ["alice", "", "codex", "another-command"],
  ])
    await settleStoredEffect(
      storage,
      owner,
      source,
      ["runtime-upgrade", runtime],
      { commandId: id },
    );
  await expect(start()).rejects.toThrow("Lost reply");
  expect(ids[1]).toBe(ids[0]);
  await settleStoredEffect(storage, "alice", "", ["runtime-upgrade", "codex"], {
    commandId: ids[0],
  });
  await expect(start()).rejects.toThrow("Lost reply");
  expect(ids[2]).not.toBe(ids[0]);
  await settleStoredEffect(storage, "alice", "", ["runtime-upgrade", "codex"], {
    commandId: ids[0],
  });
  await expect(start()).rejects.toThrow("Lost reply");
  expect(ids[3]).toBe(ids[2]);
});

it("keeps recipient history scoped to owner and exact source, with safe storage failures", () => {
  rememberRecipient("alice", "", "local-agent");
  rememberRecipient("alice", "laptop", "named-source-agent");
  rememberRecipient("alice", "docker:project", "project-agent");
  rememberRecipient("bob", "", "bob-agent");
  expect(lastRecipient("alice", "")).toBe("local-agent");
  expect(lastRecipient("alice", "laptop")).toBe("named-source-agent");
  expect(lastRecipient("alice", "docker:project")).toBe("project-agent");
  expect(lastRecipient("bob", "")).toBe("bob-agent");
  expect(lastRecipient("bob", "docker:project")).toBeNull();
  const count = storage.length;
  rememberRecipient(undefined, "", "signed-out-agent");
  expect(lastRecipient(undefined, "")).toBeNull();
  expect(storage.length).toBe(count);
  vi.spyOn(storage, "getItem").mockImplementation(() => {
    throw new Error("unavailable");
  });
  vi.spyOn(storage, "setItem").mockImplementation(() => {
    throw new Error("unavailable");
  });
  expect(lastRecipient("alice", "")).toBeNull();
  expect(() => rememberRecipient("alice", "", "accepted-agent")).not.toThrow();
});
