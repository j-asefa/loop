import { IdempotencyKey } from "../src/shared/contract-ids.js";
import { ArtifactId } from "../src/shared/contract-ids.js";
import { ConversationId } from "../src/shared/contract-ids.js";
import { callRoute, readRoute } from "../src/client/api";
import type { RouteContract, RouteInput } from "../src/shared/workspace-api";
import { workspaceApi } from "../src/shared/workspace-api";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { retryAfter } from "../src/client/api";
import { setViewOwner } from "../src/client/viewCache";

const fetcher = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  setViewOwner(undefined);
  setViewOwner("alice");
  vi.stubGlobal("fetch", fetcher);
  fetcher
    .mockReset()
    .mockImplementation(async (path) =>
      Response.json(
        String(path).endsWith("/memory")
          ? { memoryIncluded: true }
          : { items: [], failed_next: null },
      ),
    );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
// Observe the transport's first attempt; other cases below exercise its waits.
function probeRoute<C extends RouteContract & { method: "GET" }>(
  contract: C,
  input: RouteInput<C>,
  source: string,
) {
  const controller = new AbortController();
  return readRoute(
    contract,
    input,
    source,
    controller.signal,
    undefined,
    "once",
  );
}
const read = (source = "") =>
  probeRoute(
    workspaceApi.conversationMemory,
    { params: { id: ConversationId.parse("thread") } },
    source,
  );
const write = () =>
  callRoute(
    workspaceApi.artifactRefresh,
    {
      params: { id: ArtifactId.parse("artifact") },
      body: { idempotencyKey: IdempotencyKey.parse("fixture-request") },
    },
    "",
  );
const limited = (header = "8", status = 429) =>
  new Response("busy", { status, headers: { "Retry-After": header } });

it.each([429, 502, 503])(
  "HTTP %s backs off reads for only the affected source",
  async (status) => {
    fetcher.mockResolvedValueOnce(limited("8", status));
    const error = await read("docker:one").catch((error) => error);
    expect(error).toMatchObject({
      status,
      retryAfterMs: 8000,
      retryAt: Date.now() + 8000,
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(retryAfter(error)).toBe(5000);
    await expect(
      probeRoute(workspaceApi.events, { query: { after: 12 } }, "docker:one"),
    ).rejects.toMatchObject({
      status: 429,
      retryAfterMs: 5000,
    });
    await expect(read("docker:one")).rejects.toMatchObject({ status: 429 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await read("docker:two");
    await read();
    fetcher.mockResolvedValueOnce(Response.json({ added: [], own: [] }));
    await probeRoute(workspaceApi.socialFeeds, {}, "docker:one"); // routed locally
    expect(fetcher).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(5000);
    await read("docker:one");
    expect(fetcher).toHaveBeenCalledTimes(5);
  },
);

it("accepts HTTP dates and never replays a rejected mutation", async () => {
  fetcher.mockResolvedValueOnce(
    limited(new Date(Date.now() + 60_000).toUTCString()),
  );
  const error = await write().catch((error) => error);
  expect(error).toMatchObject({ status: 429, retryAfterMs: 60_000 });
  expect(error.message).not.toMatch(/retrying automatically/i);
  await vi.advanceTimersByTimeAsync(59_999);
  await expect(read()).rejects.toMatchObject({ status: 429, retryAfterMs: 1 });
  expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await read();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(
    fetcher.mock.calls.filter(([, init]) => init?.method === "POST"),
  ).toHaveLength(1);
});

it("discards cooldowns and late responses across owner changes, including signing back into the same owner", async () => {
  let finish!: (response: Response) => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const old = read().catch((error) => error);
  setViewOwner("bob");
  await read();
  setViewOwner("alice");
  finish(limited("60"));
  await old;
  await read();
  expect(fetcher).toHaveBeenCalledTimes(3);
  fetcher.mockResolvedValueOnce(limited("60"));
  await read().catch(() => {});
  setViewOwner(undefined);
  setViewOwner("alice");
  await read();
  expect(fetcher).toHaveBeenCalledTimes(5);
});

it("keeps long deadlines without timer overflow and uses a bounded fallback for malformed headers", async () => {
  fetcher.mockResolvedValueOnce(limited("3000000"));
  const error = await read().catch((error) => error);
  expect(retryAfter(error)).toBe(3_000_000_000);
  await vi.advanceTimersByTimeAsync(30_000);
  await expect(read()).rejects.toMatchObject({ retryAfterMs: 2_999_970_000 });
  setViewOwner("bob");
  fetcher.mockResolvedValueOnce(limited("broken"));
  await expect(read()).rejects.toMatchObject({ retryAfterMs: 1000 });
});

it("preserves actionable domain 429 messages without imposing a destination cooldown", async () => {
  for (const method of ["GET", "POST"]) {
    fetcher.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "This workspace has 100 pending runs. Cancel some first.",
        }),
        { status: 429, headers: { "content-type": "application/json" } },
      ),
    );
    const error = await (method === "POST" ? write() : read()).catch(
      (error) => error,
    );
    expect(error).toMatchObject({
      status: 429,
      message: "This workspace has 100 pending runs. Cancel some first.",
    });
    expect(error.retryAt).toBeUndefined();
    expect(retryAfter(error)).toBe(0);
    await expect(read()).resolves.toEqual({ memoryIncluded: true });
  }
  expect(fetcher).toHaveBeenCalledTimes(4);
});

it("retries one-shot GETs after a cooldown, but cancels retries with the view and preserves domain refusals", async () => {
  fetcher.mockResolvedValueOnce(limited("3"));
  await read().catch(() => {});
  const controller = new AbortController();
  const onRetry = vi.fn();
  const pending = readRoute(
    workspaceApi.scheduledSendList,
    {},
    "",
    controller.signal,
    onRetry,
  );
  await vi.advanceTimersByTimeAsync(2999);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(onRetry).toHaveBeenCalled();
  await expect(pending).resolves.toEqual({ items: [], failed_next: null });
  expect(fetcher).toHaveBeenCalledTimes(2);
  fetcher.mockResolvedValueOnce(limited("60"));
  const cancelled = readRoute(
    workspaceApi.reviewStatus,
    { params: { id: ConversationId.parse("thread") } },
    "",
    controller.signal,
  ).catch((error) => error);
  await vi.advanceTimersByTimeAsync(0);
  controller.abort();
  expect((await cancelled).name).toBe("AbortError");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fetcher).toHaveBeenCalledTimes(3);
  fetcher.mockResolvedValueOnce(
    new Response('{"error":"Capacity reached"}', { status: 429 }),
  );
  await expect(
    readRoute(workspaceApi.mcpCatalog, {}, "", new AbortController().signal),
  ).rejects.toThrow("Capacity reached");
  expect(fetcher).toHaveBeenCalledTimes(4);
});

it.each(["0", "0.01", "Tue, 14 Nov 2023 22:13:19 GMT"])(
  "bounds repeated 429 reads with short or past Retry-After %s",
  async (header) => {
    fetcher.mockResolvedValueOnce(limited(header));
    await expect(read()).rejects.toMatchObject({ retryAfterMs: 1000 });
    await vi.advanceTimersByTimeAsync(999);
    await expect(read()).rejects.toMatchObject({ retryAfterMs: 1 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await read();
    expect(fetcher).toHaveBeenCalledTimes(2);
  },
);

it("delivers snapshot clocks for the actual source and drops responses from a previous owner", async () => {
  const target = new EventTarget();
  vi.stubGlobal("window", target);
  const received: any[] = [];
  target.addEventListener("loop-workspace-clock", (event) =>
    received.push((event as CustomEvent).detail),
  );
  const response = (epoch: string, body: unknown = { memoryIncluded: true }) =>
    Response.json(body, {
      headers: {
        "x-loop-change-epoch": epoch,
        "x-loop-change-cursor": "19",
        "x-loop-server-now": "1000",
        "x-loop-next-deadline": "2000",
      },
    });
  fetcher.mockImplementation(async () => response("epoch"));
  await read("docker:one");
  fetcher.mockResolvedValueOnce(response("epoch", { unread: 0 }));
  await probeRoute(workspaceApi.socialUnread, {}, "docker:one");
  expect(received.map((value) => value.source)).toEqual(["docker:one", ""]);
  expect(received[0].clock).toEqual({
    epoch: "epoch",
    cursor: 19,
    serverNow: 1000,
    nextDeadline: 2000,
  });
  let finish!: (response: Response) => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const old = read("docker:one");
  setViewOwner("bob");
  finish(response("obsolete"));
  await expect(old).rejects.toThrow("unavailable response");
  expect(received).toHaveLength(2);
});

it("recovers a signal-driven snapshot from a transient server error without retrying its actions or hiding a permanent refusal", async () => {
  fetcher.mockResolvedValueOnce(
    new Response('{"error":"Temporary failure"}', { status: 503 }),
  );
  const retry = vi.fn(),
    controller = new AbortController();
  const pending = readRoute(
    workspaceApi.scheduledSendList,
    {},
    "",
    controller.signal,
    retry,
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(retry).toHaveBeenCalledWith(
    expect.objectContaining({ status: 503 }),
    2000,
  );
  await vi.advanceTimersByTimeAsync(2000);
  await expect(pending).resolves.toEqual({ items: [], failed_next: null });
  fetcher.mockImplementation(
    async () => new Response('{"error":"Still unavailable"}', { status: 503 }),
  );
  const failed = readRoute(
    workspaceApi.scheduledSendList,
    {},
    "",
    controller.signal,
  ).catch((error) => error);
  await vi.advanceTimersByTimeAsync(6000);
  expect((await failed).status).toBe(503);
  const before = fetcher.mock.calls.length;
  await vi.advanceTimersByTimeAsync(30000);
  expect(fetcher).toHaveBeenCalledTimes(before);
});

it.each(["<html>Gateway unavailable</html>", ""])(
  "retries non-JSON 503 reads (%s) without replaying a write",
  async (body) => {
    fetcher.mockResolvedValueOnce(new Response(body, { status: 503 }));
    const pending = readRoute(
      workspaceApi.conversationMemory,
      { params: { id: ConversationId.parse("completed") } },
      "",
      new AbortController().signal,
    );
    const outcome = pending.catch((error) => error);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await outcome).toEqual({ memoryIncluded: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockResolvedValueOnce(new Response(body, { status: 503 }));
    await expect(write()).rejects.toMatchObject({ status: 503 });
    await vi.advanceTimersByTimeAsync(6000);
    expect(fetcher).toHaveBeenCalledTimes(3);
  },
);

it("makes one manual retry after exhaustion and still honors Retry-After", async () => {
  fetcher.mockImplementation(
    async () => new Response("unavailable", { status: 503 }),
  );
  const controller = new AbortController();
  const automatic = readRoute(
    workspaceApi.scheduledSendList,
    {},
    "",
    controller.signal,
  ).catch((error) => error);
  await vi.advanceTimersByTimeAsync(6000);
  expect((await automatic).status).toBe(503);
  expect(fetcher).toHaveBeenCalledTimes(3);
  await expect(
    readRoute(
      workspaceApi.scheduledSendList,
      {},
      "",
      controller.signal,
      undefined,
      "manual",
    ),
  ).rejects.toMatchObject({ status: 503 });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(fetcher).toHaveBeenCalledTimes(4);

  fetcher.mockResolvedValueOnce(limited("8"));
  const manual = readRoute(
    workspaceApi.scheduledSendList,
    {},
    "",
    controller.signal,
    undefined,
    "manual",
  ).catch((error) => error);
  await vi.advanceTimersByTimeAsync(7999);
  expect(fetcher).toHaveBeenCalledTimes(5);
  await vi.advanceTimersByTimeAsync(1);
  expect((await manual).status).toBe(503);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(fetcher).toHaveBeenCalledTimes(6);
});

it("does not resume a cooling GET under a replacement owner", async () => {
  fetcher.mockResolvedValueOnce(limited("8"));
  const controller = new AbortController();
  const pending = readRoute(
    workspaceApi.conversationMemory,
    { params: { id: ConversationId.parse("thread") } },
    "",
    controller.signal,
  );
  const rejected = expect(pending).rejects.toThrow("unavailable response");
  await vi.advanceTimersByTimeAsync(0);
  expect(fetcher).toHaveBeenCalledTimes(1);
  setViewOwner("bob");
  await vi.advanceTimersByTimeAsync(8000);
  await rejected;
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("once reads report cooldowns without waiting or dispatching another request", async () => {
  fetcher.mockResolvedValueOnce(limited("8"));
  const controller = new AbortController();
  const first = readRoute(
    workspaceApi.conversationMemory,
    { params: { id: ConversationId.parse("thread") } },
    "",
    controller.signal,
    undefined,
    "once",
  );
  const rejected = expect(first).rejects.toMatchObject({ status: 429 });
  await vi.runAllTimersAsync();
  await rejected;
  expect(fetcher).toHaveBeenCalledTimes(1);
});
