import { afterEach, expect, it, vi } from "vitest";
import { createCardClient } from "../src/shared/card-client";
import { CardCollection } from "../src/shared/card-sync";
import type { CardEntry } from "../src/shared/cards";
import { syncExample } from "../examples/cards-sync";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const entry = (n: number, content = "Body"): CardEntry => ({
  card: {
    type: "message",
    id: `m:${n}`,
    role: "user",
    content,
    format: "markdown",
    source: {
      artifact_id: null,
      message_id: String(n),
      conversation_id: "thread",
      run_id: null,
      agent_id: null,
    },
    author: { kind: "owner", id: null, name: null, provider: null },
    recipient: null,
    context: {
      conversation_title: "Thread",
      folder_id: null,
      project_id: null,
      project_name: null,
      team_id: null,
    },
    created_at: n,
    updated_at: null,
    saved: false,
    attachments: [],
    href: "/?conversation=thread",
  },
  order: [n, `m:${n}`],
  saved: null,
});

it("finishes more than 120 history pages and change batches without restarting after 429", async () => {
  vi.useFakeTimers();
  let window = Math.floor(Date.now() / 60000),
    requests = 0,
    throttled = 0;
  const history: string[] = [],
    revisions: string[] = [];
  const client = createCardClient({
    baseUrl: "https://workspace.example",
    token: "fixture",
    fetch: async (input) => {
      const now = Math.floor(Date.now() / 60000);
      if (now !== window) {
        window = now;
        requests = 0;
      }
      if (++requests > 120) {
        throttled++;
        return Response.json(
          { error: "Rate limited" },
          { status: 429, headers: { "Retry-After": "60" } },
        );
      }
      const url = new URL(String(input));
      if (url.pathname.endsWith("/changes")) {
        const after = url.searchParams.get("after")!;
        revisions.push(after);
        const n = after === "first" ? 0 : Number(after);
        return Response.json({
          revision: String(n + 1),
          more: n < 120,
          items: n === 0 ? [entry(1, "Edited during backfill")] : [],
          removed: n === 120 ? ["m:0"] : [],
        });
      }
      const before = url.searchParams.get("before") || "0";
      history.push(before);
      const n = Number(before);
      return Response.json({
        revision: n === 0 ? "first" : "later-page-watermark",
        items: Array.from({ length: 100 }, (_, i) => entry(n * 100 + i)),
        next: n < 120 ? String(n + 1) : null,
      });
    },
  });
  const collection = new CardCollection(client, { view: "sent" });
  const pending = collection.sync();
  expect(collection.sync()).toBe(pending);
  let complete = false;
  void pending.then(() => {
    complete = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(complete).toBe(false);
  await vi.advanceTimersByTimeAsync(60000);
  expect(complete).toBe(false);
  await vi.advanceTimersByTimeAsync(60000);
  const result = await pending;
  expect(throttled).toBe(2);
  expect(history).toHaveLength(121);
  expect(new Set(history).size).toBe(121);
  expect(revisions).toHaveLength(121);
  expect(revisions[0]).toBe("first");
  expect(result).toHaveLength(12099);
  expect(result.some((e) => e.card.id === "m:0")).toBe(false);
  expect(result.find((e) => e.card.id === "m:1")?.card.content).toBe(
    "Edited during backfill",
  );
  await collection.sync();
  expect(history).toHaveLength(121);
  expect(revisions.at(-1)).toBe("121");
});

it.each([undefined, null])(
  "can cancel a rate-limit wait with reason %s and does not retry denials or unspecified backoff",
  async (reason) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const send = vi.fn(async () =>
      Response.json(
        { error: "Wait" },
        { status: 429, headers: { "Retry-After": "60" } },
      ),
    );
    const client = createCardClient({
      baseUrl: "https://workspace.example",
      token: "fixture",
      fetch: send,
    });
    const collection = new CardCollection(client, { view: "results" });
    const pending = collection.sync(controller.signal);
    const rejected =
      reason === null
        ? expect(pending).rejects.toBeNull()
        : expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(reason);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
    for (const status of [401, 403, 404, 429, 500]) {
      send.mockImplementationOnce(async () =>
        Response.json({ error: "Denied" }, { status }),
      );
      await expect(collection.sync()).rejects.toMatchObject({ status });
    }
    expect(send).toHaveBeenCalledTimes(6);
  },
);

it("rejects a different concurrent cancellation signal without disturbing the active sync", async () => {
  vi.useFakeTimers();
  const first = new AbortController(),
    second = new AbortController();
  const send = vi.fn(async () =>
    Response.json(
      { error: "Wait" },
      { status: 429, headers: { "Retry-After": "60" } },
    ),
  );
  const collection = new CardCollection(
    createCardClient({
      baseUrl: "https://workspace.example",
      token: "fixture",
      fetch: send,
    }),
    { view: "results" },
  );
  const pending = collection.sync(first.signal);
  const rejected = expect(pending).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(collection.sync(first.signal)).toBe(pending);
  await expect(collection.sync(second.signal)).rejects.toThrow(
    "same AbortSignal",
  );
  await expect(collection.sync()).rejects.toThrow("same AbortSignal");
  await vi.advanceTimersByTimeAsync(0);
  second.abort();
  expect(vi.getTimerCount()).toBe(1);
  expect(send).toHaveBeenCalledTimes(1);
  first.abort();
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
  await expect(collection.sync(second.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(send).toHaveBeenCalledTimes(1);
});

it("keeps an actual project named unfiled separate from cards with no project", async () => {
  const unfiled = entry(1),
    filed = entry(2);
  filed.card.context.project_id = "unfiled";
  filed.card.context.project_name = "Actual project";
  vi.stubGlobal("fetch", async (input: string) =>
    Response.json(
      new URL(input).pathname.endsWith("/changes")
        ? { revision: "second", items: [], removed: [], more: false }
        : { revision: "first", items: [unfiled, filed], next: null },
    ),
  );
  const read = await syncExample({
    CARDS_BASE_URL: "https://workspace.example",
    CARDS_TOKEN: "fixture",
    CARDS_VIEW: "sent",
  });
  const { projects } = await read();
  expect(projects).toHaveLength(2);
  expect(new Set(projects.map((p) => p.id)).size).toBe(2);
  expect(
    projects
      .find((p) => p.name === "Unfiled")
      ?.cards.map((c) => c.entry.card.id),
  ).toEqual(["m:1"]);
  expect(
    projects
      .find((p) => p.name === "Actual project")
      ?.cards.map((c) => c.entry.card.id),
  ).toEqual(["m:2"]);
});

it("rejects Results search before a request and omits blank example and collection queries", async () => {
  const send = vi.fn(async (input: string) => {
    expect(new URL(input).searchParams.has("q")).toBe(false);
    return Response.json(
      new URL(input).pathname.endsWith("/changes")
        ? { revision: "second", items: [], removed: [], more: false }
        : { revision: "first", items: [], next: null },
    );
  });
  vi.stubGlobal("fetch", send);
  const environment = {
    CARDS_BASE_URL: "https://workspace.example",
    CARDS_TOKEN: "fixture",
    CARDS_QUERY: "find this",
  };
  await expect(syncExample(environment)).rejects.toThrow("CARDS_VIEW=saved");
  expect(send).not.toHaveBeenCalled();
  const read = await syncExample({ ...environment, CARDS_QUERY: "  " });
  expect((await read()).projects).toEqual([]);
  for (const view of ["results", "saved", "sent"] as const) {
    const collection = new CardCollection(
      createCardClient({
        baseUrl: environment.CARDS_BASE_URL,
        token: environment.CARDS_TOKEN,
      }),
      { view, q: "  " },
    );
    expect(await collection.sync()).toEqual([]);
  }
  expect(send).toHaveBeenCalledTimes(8);
});

it("protects shared snapshots, rolls back failed deltas, and backfills after a 409", async () => {
  const responses = [
    { after: null, body: { revision: "r0", items: [entry(1)], next: null } },
    {
      after: "r0",
      body: { revision: "r1", items: [], removed: [], more: false },
    },
    {
      after: "r1",
      body: { revision: "r2", items: [entry(2)], removed: ["m:1"], more: true },
    },
    { after: "r2", body: { error: "Interrupted" }, status: 500 },
    {
      after: "r1",
      body: {
        revision: "r3",
        items: [entry(2)],
        removed: ["m:1"],
        more: false,
      },
    },
    { after: "r3", body: { error: "Reset" }, status: 409 },
    { after: null, body: { revision: "r4", items: [entry(3)], next: null } },
    {
      after: "r4",
      body: { revision: "r5", items: [], removed: [], more: false },
    },
  ];
  const send = vi.fn(async (input: string | URL | Request) => {
    const response = responses.shift();
    expect(response).toBeDefined();
    expect(new URL(String(input)).searchParams.get("after")).toBe(
      response!.after,
    );
    return Response.json(response!.body, { status: response!.status || 200 });
  });
  const client = createCardClient({
    baseUrl: "https://workspace.example",
    token: "fixture",
    fetch: send,
  });
  let readerEntry: CardEntry | undefined;
  const collection = new CardCollection(
    {
      ...client,
      list: async (...args) => {
        const page = await client.list(...args);
        // A caller-supplied reader may already freeze only the outer entry.
        readerEntry = page.items[0];
        page.items.forEach(Object.freeze);
        return page;
      },
    },
    { view: "sent" },
  );
  const pending = collection.sync();
  expect(collection.sync()).toBe(pending);
  const first = await pending;
  expect(Reflect.set(first, 0, entry(99))).toBe(false);
  expect(Reflect.set(first[0].card, "content", "Local edit")).toBe(false);
  expect(Reflect.set(first[0].card.author, "name", "Local author")).toBe(false);
  expect(Reflect.set(first[0].order, 0, 999)).toBe(false);
  expect(Reflect.set(readerEntry!.card, "content", "Reader edit")).toBe(true);
  expect(first[0].card.content).toBe("Body");
  await expect(collection.sync()).rejects.toMatchObject({ status: 500 });
  expect(first[0].card.content).toBe("Body");
  expect(first.map((e) => e.card.id)).toEqual(["m:1"]);
  const next = await collection.sync();
  expect(next.map((e) => e.card.id)).toEqual(["m:2"]);
  await expect(collection.sync()).rejects.toMatchObject({ status: 409 });
  expect(send).toHaveBeenCalledTimes(6); // No automatic reset retry.
  expect((await collection.sync()).map((e) => e.card.id)).toEqual(["m:3"]);
  expect(responses).toEqual([]);
});

it("honors Retry-After beyond the platform timer limit without retrying early", async () => {
  vi.useFakeTimers();
  const seconds = 30 * 24 * 60 * 60;
  const send = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json(
        { error: "Wait" },
        { status: 429, headers: { "Retry-After": String(seconds) } },
      ),
    )
    .mockResolvedValueOnce(
      Response.json({ revision: "r0", items: [], next: null }),
    )
    .mockResolvedValueOnce(
      Response.json({ revision: "r1", items: [], removed: [], more: false }),
    );
  const collection = new CardCollection(
    createCardClient({
      baseUrl: "https://workspace.example",
      token: "fixture",
      fetch: send,
    }),
    { view: "results" },
  );
  const pending = collection.sync();
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(2147483647);
  expect(send).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(seconds * 1000 - 2147483647 - 1);
  expect(send).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toEqual([]);
  expect(send).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
});
