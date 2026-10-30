import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { fleetPayloadDigest } from "../src/server/fleet-crypto";
import { fleetActionInput } from "../src/shared/fleet-action-input";
import { workspaceApi } from "../src/shared/workspace-api";

// Unit cases isolate command policy; browser fixtures exercise real IndexedDB.
vi.mock("../src/client/fleetCommandStorage", () => ({
  readFleetJournal: async (key: string) => localStorage.getItem(key),
  writeFleetJournal: async (key: string, value: string) => {
    localStorage.setItem(key, value);
    await afterJournalWrite?.();
  },
}));

const source = "peer:m_" + "1".repeat(64),
  other = "peer:m_" + "2".repeat(64);
let storage: Map<string, string>;
let fetcher: ReturnType<typeof vi.fn>;
let api: typeof import("../src/client/api");
let views: typeof import("../src/client/viewCache");
let beforeSession: (() => void | Promise<void>) | undefined;
let afterJournalWrite: (() => Promise<void>) | undefined;
let beforeFetch:
  ((url: string, init: RequestInit) => Promise<Response>) | undefined;
const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const terminal = (
  id: string,
  body: unknown = { state: "answered" },
  state = "completed",
  status = 200,
) =>
  json(body, status, {
    "x-loop-command-id": id,
    "x-loop-command-state": state,
  });
const rows = () => [...storage.values()].flatMap((value) => JSON.parse(value));
async function page(owner = "fixture-owner") {
  vi.resetModules();
  api = await import("../src/client/api");
  views = await import("../src/client/viewCache");
  views.setViewOwner(owner);
  const sources = await import("../src/client/sourceRouting");
  sources.setShellSource(source);
}
beforeEach(async () => {
  storage = new Map();
  beforeFetch = undefined;
  beforeSession = undefined;
  afterJournalWrite = undefined;
  vi.stubGlobal("location", { href: "https://gateway.example/", search: "" });
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
  });
  const tails = new Map<string, Promise<unknown>>();
  vi.stubGlobal("navigator", {
    locks: {
      request: (
        key: string,
        options: { ifAvailable?: boolean },
        fn: (lock: { name: string } | null) => unknown,
      ) => {
        if (options.ifAvailable && tails.has(key))
          return Promise.resolve(fn(null));
        const task = (tails.get(key) ?? Promise.resolve()).then(() =>
          fn({ name: key }),
        );
        const tail = task.catch(() => {});
        tails.set(key, tail);
        void tail.finally(() => {
          if (tails.get(key) === tail) tails.delete(key);
        });
        return task;
      },
    },
  });
  fetcher = vi.fn(async (url: string, init: RequestInit) => {
    if (url === "/session") {
      await beforeSession?.();
      return json({ csrf: "isolated-csrf" });
    }
    if (beforeFetch) return beforeFetch(url, init);
    return terminal(new Headers(init.headers).get("x-loop-command-id")!);
  });
  vi.stubGlobal("fetch", fetcher);
  await page();
});
afterEach(() => vi.unstubAllGlobals());

it.each(["abort", "owner change"])(
  "releases only its unsent reservation after %s during a journal commit",
  async (cancel) => {
    const key = "loop:fleet-commands:v1:fixture-owner";
    const previous = {
      params: { id: randomUUID() },
      body: { commandId: randomUUID(), answer: { message: "older intent" } },
    };
    beforeFetch = async () => json({ error: "Older outcome is unknown" }, 503);
    await expect(
      api.callRoute(workspaceApi.nativeAnswer, previous, source),
    ).rejects.toThrow("Older outcome is unknown");
    const retained = storage.get(key);
    fetcher.mockClear();
    beforeFetch = undefined;
    let committed!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      committed = resolve;
    });
    const completion = new Promise<void>((resolve) => {
      release = resolve;
    });
    afterJournalWrite = async () => {
      afterJournalWrite = undefined;
      committed();
      await completion;
    };
    const controller = new AbortController();
    const input = {
      params: { id: randomUUID() },
      body: { commandId: randomUUID(), answer: { message: "unsent intent" } },
    };
    const pending = api
      .callRoute(workspaceApi.nativeAnswer, input, source, controller.signal)
      .catch((error) => error);
    await entered;
    if (cancel === "abort") controller.abort();
    else {
      storage.set("loop:fleet-commands:v1:replacement-owner", "[]");
      views.setViewOwner("replacement-owner");
    }
    release();
    expect(await pending).toBeInstanceOf(Error);
    expect(fetcher).not.toHaveBeenCalled();
    expect(storage.get(key)).toBe(retained);
    if (cancel === "owner change")
      expect(storage.get("loop:fleet-commands:v1:replacement-owner")).toBe(
        "[]",
      );
    await page();
    beforeFetch = async (_url, init) => {
      const headers = new Headers(init.headers);
      expect(headers.get("x-loop-command-id")).toBe(input.body.commandId);
      expect(headers.has("x-loop-receipt-only")).toBe(false);
      return terminal(input.body.commandId);
    };
    await expect(
      api.callRoute(workspaceApi.nativeAnswer, input, source),
    ).resolves.toEqual({ state: "answered" });
    expect(
      fetcher.mock.calls.filter(([url]) => url !== "/session"),
    ).toHaveLength(1);
    expect(storage.get(key)).toBe(retained);
  },
);

it("persists before IO and reconciles the same native decision after reload even if the caller proposes a new key", async () => {
  const original = randomUUID(),
    replacement = randomUUID(),
    decision = randomUUID();
  const received: { id: string; receipt: string | null; body: any }[] = [];
  beforeFetch = async (url, init) => {
    const headers = new Headers(init.headers),
      id = headers.get("x-loop-command-id")!;
    expect(rows()).toEqual([
      {
        id: original,
        source,
        route: "nativeAnswer",
        signature: expect.stringMatching(/^[a-f0-9]{64}$/),
        payloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ]);
    const body = JSON.parse(String(init.body));
    received.push({ id, receipt: headers.get("x-loop-receipt-only"), body });
    expect(body.commandId).toBe(original);
    if (received.length === 1) throw new TypeError("Lost committed response");
    return terminal(id);
  };
  await expect(
    api.callRoute(
      workspaceApi.nativeAnswer,
      {
        params: { id: decision },
        body: { commandId: original, answer: { message: "private reply" } },
      },
      source,
    ),
  ).rejects.toThrow();
  expect(JSON.stringify([...storage.values()])).not.toContain("private reply");
  await page();
  await expect(
    api.callRoute(
      workspaceApi.nativeAnswer,
      {
        params: { id: decision },
        body: { commandId: replacement, answer: { message: "private reply" } },
      },
      source,
    ),
  ).resolves.toEqual({ state: "answered" });
  expect(received.map((item) => [item.id, item.receipt])).toEqual([
    [original, null],
    [original, "1"],
  ]);
  expect(rows()).toEqual([]);
});

it("normalizes optional create/composer fields to their JSON representation before validation and hashing", async () => {
  const created = randomUUID(),
    sent = randomUUID(),
    agentId = randomUUID();
  const seen: { id: string; query: boolean; body: Record<string, unknown> }[] =
    [];
  beforeFetch = async (_url, init) => {
    const headers = new Headers(init.headers);
    seen.push({
      id: headers.get("x-loop-command-id")!,
      query: headers.has("x-loop-receipt-only"),
      body: JSON.parse(String(init.body)),
    });
    return json({ error: "Fixture response unavailable" }, 503);
  };
  await expect(
    api.callRoute(
      workspaceApi.agentCreate,
      {
        body: {
          name: "fixture",
          connectionId: randomUUID(),
          model: "fixture",
          effort: null,
          instructions: "",
          initialPrompt: "",
          attachmentIds: [],
          folderId: undefined,
          idempotencyKey: created,
        },
      },
      source,
    ),
  ).rejects.toThrow("Fixture response unavailable");
  await expect(
    api.callRoute(
      workspaceApi.submit,
      {
        body: {
          agentId,
          input: "unchanged message",
          conversationId: undefined,
          replyToMessageId: undefined,
          replyExcerpt: undefined,
          folderId: undefined,
          attachmentIds: [],
          idempotencyKey: sent,
        },
      },
      source,
    ),
  ).rejects.toThrow("Fixture response unavailable");
  expect(seen).toHaveLength(2);
  expect(seen[0].body).not.toHaveProperty("folderId");
  expect(seen[1].body).not.toHaveProperty("replyToMessageId");
  expect(seen[1].body).not.toHaveProperty("replyExcerpt");
  await page();
  await expect(
    api.callRoute(
      workspaceApi.submit,
      {
        body: {
          agentId,
          input: "unchanged message",
          attachmentIds: [],
          idempotencyKey: randomUUID(),
        },
      },
      source,
    ),
  ).rejects.toThrow("Fixture response unavailable");
  expect(seen.map(({ id, query }) => ({ id, query }))).toEqual([
    { id: created, query: false },
    { id: sent, query: false },
    { id: sent, query: true },
  ]);
});

it("keeps owner and machine identities separate despite identical local IDs and payloads", async () => {
  beforeFetch = async (url) => {
    throw new TypeError("Fixture disconnect");
  };
  const input = {
    params: { id: "same-local-decision" },
    body: { decision: "approve" as const },
  };
  await expect(
    api.callRoute(workspaceApi.approval, input, source),
  ).rejects.toThrow();
  await expect(
    api.callRoute(workspaceApi.approval, input, other),
  ).rejects.toThrow();
  await page("another-owner");
  await expect(
    api.callRoute(workspaceApi.approval, input, source),
  ).rejects.toThrow();
  expect(new Set(rows().map((row) => row.id)).size).toBe(3);
  expect(storage.size).toBe(2);
  expect([...storage.keys()].some((key) => key.includes("another-owner"))).toBe(
    true,
  );
});

it("refuses unavailable, corrupt or full browser storage before any fetch", async () => {
  const call = () =>
    api.callRoute(
      workspaceApi.approval,
      { params: { id: "decision" }, body: { decision: "approve" } },
      source,
    );
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {
      throw new Error("Fixture quota");
    },
  });
  await expect(call()).rejects.toThrow("retained safely");
  expect(fetcher).not.toHaveBeenCalled();
  vi.stubGlobal("localStorage", {
    getItem: () => "{invalid",
    setItem: vi.fn(),
  });
  await expect(call()).rejects.toThrow("retained safely");
  expect(fetcher).not.toHaveBeenCalled();
  vi.stubGlobal("navigator", {});
  await expect(call()).rejects.toThrow("updated browser");
  expect(fetcher).not.toHaveBeenCalled();
});

it("does not reuse an unresolved command ID for another payload", async () => {
  const id = randomUUID();
  beforeFetch = async (url) => {
    throw new TypeError("Fixture disconnect");
  };
  const input = {
    params: { id: "decision" },
    body: { commandId: id, answer: { value: "first" } },
  };
  await expect(
    api.callRoute(workspaceApi.nativeAnswer, input, source),
  ).rejects.toThrow();
  const calls = fetcher.mock.calls.length;
  await expect(
    api.callRoute(
      workspaceApi.nativeAnswer,
      { ...input, body: { commandId: id, answer: { value: "different" } } },
      source,
    ),
  ).rejects.toThrow("retained safely");
  expect(fetcher).toHaveBeenCalledTimes(calls);
  expect(rows()).toHaveLength(1);
});

it("two concurrent callers share one original intent and at most one action request", async () => {
  const commands: { id: string; query: boolean }[] = [];
  beforeFetch = async (url, init) => {
    const headers = new Headers(init.headers),
      id = headers.get("x-loop-command-id")!;
    commands.push({ id, query: headers.has("x-loop-receipt-only") });
    return json({ error: "Fixture unknown", executionOutcome: "unknown" }, 503);
  };
  const input = {
    params: { id: "decision" },
    body: { decision: "approve" as const },
  };
  const result = await Promise.allSettled([
    api.callRoute(workspaceApi.approval, input, source),
    api.callRoute(workspaceApi.approval, input, source),
  ]);
  expect(result.every((item) => item.status === "rejected")).toBe(true);
  expect(new Set(commands.map((item) => item.id)).size).toBe(1);
  expect(commands.filter((item) => !item.query)).toHaveLength(1);
  expect(rows()).toHaveLength(1);
});

it("releases a new intent when device authorization fails before the action fetch", async () => {
  const decision = randomUUID(),
    first = randomUUID();
  const call = (id: string) =>
    api.callRoute(
      workspaceApi.nativeAnswer,
      {
        params: { id: decision },
        body: { commandId: id, answer: { message: "retry unchanged answer" } },
      },
      source,
    );
  beforeSession = () => {
    throw new TypeError("Fixture session unavailable");
  };
  await expect(call(first)).rejects.toMatchObject({
    executionOutcome: "not_sent",
  });
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/session"]);
  expect(rows()).toEqual([]);
  beforeSession = undefined;
  await expect(call(first)).resolves.toEqual({ state: "answered" });
  const actions = fetcher.mock.calls.filter(([url]) => url !== "/session");
  expect(actions).toHaveLength(1);
  expect(new Headers(actions[0][1].headers).get("x-loop-command-id")).toBe(
    first,
  );
  expect(new Headers(actions[0][1].headers).has("x-loop-receipt-only")).toBe(
    false,
  );
});

it("releases only its captured unsent entry when authorization aborts the request", async () => {
  const controller = new AbortController(),
    id = randomUUID();
  beforeSession = () => controller.abort();
  const input = {
    params: { id: "aborted-decision" },
    body: { commandId: id, answer: { message: "retry after abort" } },
  };
  await expect(
    api.callRoute(workspaceApi.nativeAnswer, input, source, controller.signal),
  ).rejects.toMatchObject({ executionOutcome: "not_sent" });
  expect(rows()).toEqual([]);
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/session"]);
  beforeSession = undefined;
  await expect(
    api.callRoute(workspaceApi.nativeAnswer, input, source),
  ).resolves.toEqual({ state: "answered" });
  const actions = fetcher.mock.calls.filter(([url]) => url !== "/session");
  expect(actions).toHaveLength(1);
  expect(new Headers(actions[0][1].headers).get("x-loop-command-id")).toBe(id);
  expect(new Headers(actions[0][1].headers).has("x-loop-receipt-only")).toBe(
    false,
  );
});

it("cancels one stalled authorization waiter without cancelling the shared request", async () => {
  let release!: () => void;
  beforeSession = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const controller = new AbortController();
  const firstId = randomUUID(),
    secondId = randomUUID();
  const input = (id: string) => ({
    params: { id },
    body: { commandId: id, answer: { message: "isolated authorization" } },
  });
  let aborted: unknown, continued: unknown;
  const first = api
    .callRoute(
      workspaceApi.nativeAnswer,
      input(firstId),
      source,
      controller.signal,
    )
    .catch((error) => {
      aborted = error;
    });
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const second = api
    .callRoute(workspaceApi.nativeAnswer, input(secondId), source)
    .then(
      (value) => {
        continued = value;
      },
      (error) => {
        continued = error;
      },
    );
  try {
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    controller.abort();
    await vi.waitFor(() =>
      expect(aborted).toMatchObject({ executionOutcome: "not_sent" }),
    );
    expect(continued).toBeUndefined();
    expect(rows().map((row) => row.id)).toEqual([secondId]);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/session"]);
  } finally {
    release();
    await Promise.all([first, second]);
  }
  expect(continued).toEqual({ state: "answered" });
  const actions = fetcher.mock.calls.filter(([url]) => url !== "/session");
  expect(actions).toHaveLength(1);
  expect(new Headers(actions[0][1].headers).get("x-loop-command-id")).toBe(
    secondId,
  );
  expect(rows()).toEqual([]);
});

it("keeps an uncertain original intent if a later receipt query fails authorization", async () => {
  const decision = randomUUID(),
    original = randomUUID();
  const call = (id: string) =>
    api.callRoute(
      workspaceApi.nativeAnswer,
      {
        params: { id: decision },
        body: { commandId: id, answer: { message: "accepted answer" } },
      },
      source,
    );
  beforeFetch = async () => {
    throw new TypeError("Fixture lost action response");
  };
  await expect(call(original)).rejects.toMatchObject({
    executionOutcome: "unknown",
  });
  api.clearAuthorization();
  beforeSession = () => {
    throw new TypeError("Fixture session unavailable");
  };
  await expect(call(randomUUID())).rejects.toMatchObject({
    executionOutcome: "unknown",
  });
  expect(rows()).toHaveLength(1);
  expect(rows()[0].id).toBe(original);
  beforeSession = undefined;
  beforeFetch = async (_url, init) => {
    const headers = new Headers(init.headers);
    expect(headers.get("x-loop-command-id")).toBe(original);
    expect(headers.get("x-loop-receipt-only")).toBe("1");
    return terminal(original);
  };
  await expect(call(randomUUID())).resolves.toEqual({ state: "answered" });
  expect(fetcher.mock.calls.filter(([url]) => url !== "/session")).toHaveLength(
    2,
  );
  expect(rows()).toEqual([]);
});

it("rechecks owner generation after asynchronous device authorization before forwarding", async () => {
  const replacementKey = "loop:fleet-commands:v1:replacement-owner";
  const replacement = JSON.stringify([
    {
      id: randomUUID(),
      source,
      route: "approval",
      signature: "a".repeat(64),
      payloadDigest: "b".repeat(64),
    },
  ]);
  beforeSession = () => {
    storage.set(replacementKey, replacement);
    views.setViewOwner("replacement-owner");
  };
  await expect(
    api.callRoute(
      workspaceApi.approval,
      { params: { id: "decision" }, body: { decision: "approve" } },
      source,
    ),
  ).rejects.toThrow("session changed");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(storage.get("loop:fleet-commands:v1:fixture-owner")).toBe("[]");
  expect(storage.get(replacementKey)).toBe(replacement);
});

it("does not settle uncertainty from a missing, wrong or malformed completion response", async () => {
  let mode = "missing";
  let refusedId: string | undefined;
  beforeFetch = async (url, init) => {
    const id = new Headers(init.headers).get("x-loop-command-id")!;
    if (mode === "success") {
      expect(id).not.toBe(refusedId);
      expect(new Headers(init.headers).has("x-loop-receipt-only")).toBe(false);
      return terminal(id, { ok: true });
    }
    if (mode === "missing") return json({ ok: true });
    if (mode === "wrong") return terminal(randomUUID(), { ok: true });
    if (mode === "malformed") return terminal(id, { wrong: true });
    if (mode === "admission")
      return json(
        { error: "Device expired", executionOutcome: "refused" },
        403,
      );
    return terminal(
      id,
      { error: "Destination refused", executionOutcome: "refused" },
      "refused",
      409,
    );
  };
  const input = {
    params: { id: "decision" },
    body: { decision: "approve" as const },
  };
  for (mode of ["missing", "wrong", "malformed", "admission"]) {
    await expect(
      api.callRoute(workspaceApi.approval, input, source),
    ).rejects.toMatchObject({
      executionOutcome: mode === "malformed" ? "completed" : "unknown",
    });
    expect(rows()).toHaveLength(1);
  }
  refusedId = rows()[0].id;
  mode = "refused";
  await expect(
    api.callRoute(workspaceApi.approval, input, source),
  ).rejects.toMatchObject({
    message: "Destination refused",
    executionOutcome: "refused",
  });
  expect(rows()).toEqual([]);
  mode = "success";
  await expect(
    api.callRoute(workspaceApi.approval, input, source),
  ).resolves.toEqual({ ok: true });
  expect(rows()).toEqual([]);
});

it("a late response after an owner switch cannot finish the old browser intent", async () => {
  beforeFetch = async (url, init) => {
    views.setViewOwner("replacement-owner");
    return terminal(new Headers(init.headers).get("x-loop-command-id")!, {
      ok: true,
    });
  };
  await expect(
    api.callRoute(
      workspaceApi.approval,
      { params: { id: "decision" }, body: { decision: "approve" } },
      source,
    ),
  ).rejects.toThrow("session changed");
  expect(rows()).toHaveLength(1);
});

it("queries a persisted receipt after reload without retaining its body and keeps unknown or invalid replies pending", async () => {
  const id = randomUUID(),
    decision = randomUUID(),
    body = {
      commandId: id,
      answer: { message: "private receipt lookup input" },
    };
  beforeFetch = async (url) => {
    throw new TypeError("Lost response");
  };
  await expect(
    api.callRoute(
      workspaceApi.nativeAnswer,
      { params: { id: decision }, body },
      source,
    ),
  ).rejects.toThrow();
  await page();
  const commands = await import("../src/client/fleetCommand");
  const pending = (await commands.pendingFleetCommands())[0];
  expect(pending.payloadDigest).toBe(
    fleetPayloadDigest(
      fleetActionInput(
        { route: "nativeAnswer", params: { id: decision }, body },
        id,
      ),
    ),
  );
  expect(JSON.stringify(rows())).not.toContain("private receipt lookup input");
  let state = "unknown",
    returnedId = id,
    result: unknown = null;
  beforeFetch = async (url, init) => {
    expect(url).toBe("/api/fleet/commands/receipt");
    expect(JSON.parse(String(init.body))).toEqual({
      peer: source.slice(5),
      commandId: id,
      route: "nativeAnswer",
      payloadDigest: pending.payloadDigest,
    });
    expect(new Headers(init.headers).has("x-loop-command-id")).toBe(false);
    return json({ commandId: returnedId, state, result });
  };
  expect((await commands.reconcileFleetCommand(pending)).state).toBe("unknown");
  expect(await commands.pendingFleetCommands()).toHaveLength(1);
  state = "completed";
  returnedId = randomUUID();
  await expect(commands.reconcileFleetCommand(pending)).rejects.toThrow(
    "different command",
  );
  returnedId = id;
  result = { unexpected: "private context" };
  await expect(commands.reconcileFleetCommand(pending)).rejects.toThrow();
  expect(await commands.pendingFleetCommands()).toHaveLength(1);
  result = null;
  expect(await commands.reconcileFleetCommand(pending)).toEqual({
    commandId: id,
    state: "completed",
    result: null,
  });
  expect(await commands.pendingFleetCommands()).toEqual([]);
});

it("does not query an old owner's receipt when authorization changes the browser owner", async () => {
  const id = randomUUID();
  beforeFetch = async (url) => {
    throw new TypeError("Lost response");
  };
  await expect(
    api.callRoute(
      workspaceApi.nativeAnswer,
      {
        params: { id: "decision" },
        body: { commandId: id, answer: { value: "keep" } },
      },
      source,
    ),
  ).rejects.toThrow();
  await page();
  const commands = await import("../src/client/fleetCommand");
  const pending = (await commands.pendingFleetCommands())[0];
  fetcher.mockClear();
  beforeSession = () => views.setViewOwner("another-owner");
  await expect(commands.reconcileFleetCommand(pending)).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(rows()).toHaveLength(1);
  await expect(commands.reconcileFleetCommand(pending)).rejects.toThrow(
    "another workspace",
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("retains the original command for bodyless mutations while unsupported contracts refuse before IO", async () => {
  const path = "/scheduled-sends/scheduled" as const;
  const received: { id: string; query: string | null }[] = [];
  beforeFetch = async (url, init) => {
    expect(url).toBe(`/api/agent-sources/${encodeURIComponent(source)}${path}`);
    const headers = new Headers(init.headers),
      id = headers.get("x-loop-command-id")!;
    expect(rows()[0].id).toBe(id);
    received.push({ id, query: headers.get("x-loop-receipt-only") });
    if (received.length === 1) throw new TypeError("Lost cancellation reply");
    return terminal(id, { ok: true });
  };
  await expect(
    api.callRoute(
      workspaceApi.scheduledSendCancel,
      { params: { id: "scheduled" }, body: undefined },
      source,
    ),
  ).rejects.toThrow();
  await page();
  expect(
    await api.callRoute(
      workspaceApi.scheduledSendCancel,
      { params: { id: "scheduled" }, body: undefined },
      source,
    ),
  ).toEqual({
    ok: true,
  });
  expect(received[1]).toEqual({ id: received[0].id, query: "1" });
  expect(rows()).toEqual([]);
  const count = fetcher.mock.calls.length;
  await expect(
    api.callRoute(
      workspaceApi.mcpPreferencesUpdate,
      { body: { approvalMode: "ask" } },
      source,
    ),
  ).rejects.toThrow("remote operation is unavailable");
  expect(fetcher).toHaveBeenCalledTimes(count);
});
