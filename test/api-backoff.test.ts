import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { apiInWorkspace, readInWorkspace, retryAfter } from "../src/client/api";
import { setViewOwner } from "../src/client/viewCache";

const fetcher = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  setViewOwner(undefined);
  setViewOwner("alice");
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockReset().mockImplementation(async () => new Response("{}"));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const read = (source = "", path: import("../src/client/legacy-paths").LegacyClientPath = "/conversations/thread/usage") => apiInWorkspace(path, source);
const limited = (header = "8") => new Response("busy", { status: 429, headers: { "Retry-After": header } });

it("surfaces Retry-After and backs off every read for only the rate-limited source", async () => {
  fetcher.mockResolvedValueOnce(limited());
  const error = await read("docker:one").catch(error => error);
  expect(error).toMatchObject({ status: 429, retryAfterMs: 8000, retryAt: Date.now() + 8000 });
  await vi.advanceTimersByTimeAsync(3000);
  expect(retryAfter(error)).toBe(5000);
  await expect(read("docker:one", "/events?after=12")).rejects.toMatchObject({ status: 429, retryAfterMs: 5000 });
  await expect(read("docker:one", "/conversations/thread/usage")).rejects.toMatchObject({ status: 429 });
  expect(fetcher).toHaveBeenCalledTimes(1);
  await read("docker:two");
  await read();
  await read("docker:one", "/social/feeds"); // routed locally
  expect(fetcher).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(5000);
  await read("docker:one");
  expect(fetcher).toHaveBeenCalledTimes(5);
});

it("accepts HTTP dates and never replays a rejected mutation", async () => {
  fetcher.mockResolvedValueOnce(limited(new Date(Date.now() + 60_000).toUTCString()));
  const error = await apiInWorkspace("/agents", "", { input: "once" }).catch(error => error);
  expect(error).toMatchObject({ status: 429, retryAfterMs: 60_000 });
  expect(error.message).not.toMatch(/retrying automatically/i);
  await vi.advanceTimersByTimeAsync(59_999);
  await expect(read()).rejects.toMatchObject({ status: 429, retryAfterMs: 1 });
  expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await read();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});

it("discards cooldowns and late responses across owner changes, including signing back into the same owner", async () => {
  let finish!: (response: Response) => void;
  fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const old = read().catch(error => error);
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
  const error = await read().catch(error => error);
  expect(retryAfter(error)).toBe(3_000_000_000);
  await vi.advanceTimersByTimeAsync(30_000);
  await expect(read()).rejects.toMatchObject({ retryAfterMs: 2_999_970_000 });
  setViewOwner("bob");
  fetcher.mockResolvedValueOnce(limited("broken"));
  await expect(read()).rejects.toMatchObject({ retryAfterMs: 1000 });
});

it("preserves actionable domain 429 messages without imposing a destination cooldown", async () => {
  for (const method of ["GET", "POST"]) {
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ error: "This workspace has 100 pending runs. Cancel some first." }), { status: 429, headers: { "content-type": "application/json" } }));
    const error = await apiInWorkspace("/agents", "", method === "POST" ? { input: "once" } : undefined, method).catch(error => error);
    expect(error).toMatchObject({ status: 429, message: "This workspace has 100 pending runs. Cancel some first." });
    expect(error.retryAt).toBeUndefined();
    expect(retryAfter(error)).toBe(0);
    await expect(read()).resolves.toEqual({});
  }
  expect(fetcher).toHaveBeenCalledTimes(4);
});


it("retries one-shot GETs after a cooldown, but cancels retries with the view and preserves domain refusals", async () => {
  fetcher.mockResolvedValueOnce(limited("3"));
  await read().catch(() => {});
  const controller = new AbortController();
  const onRetry = vi.fn();
  const pending = readInWorkspace("/scheduled-sends", "", controller.signal, onRetry);
  await vi.advanceTimersByTimeAsync(2999);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(onRetry).toHaveBeenCalled();
  await expect(pending).resolves.toEqual({});
  expect(fetcher).toHaveBeenCalledTimes(2);
  fetcher.mockResolvedValueOnce(limited("60"));
  const cancelled = readInWorkspace("/reviews/conversation/thread", "", controller.signal).catch(error => error);
  await vi.advanceTimersByTimeAsync(0);
  controller.abort();
  expect((await cancelled).name).toBe("AbortError");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fetcher).toHaveBeenCalledTimes(3);
  fetcher.mockResolvedValueOnce(new Response('{"error":"Capacity reached"}', { status: 429 }));
  await expect(readInWorkspace("/mcp/catalog", "", new AbortController().signal)).rejects.toThrow("Capacity reached");
  expect(fetcher).toHaveBeenCalledTimes(4);
});


it.each(["0", "0.01", "Tue, 14 Nov 2023 22:13:19 GMT"])("bounds repeated 429 reads with short or past Retry-After %s", async header => {
  fetcher.mockResolvedValueOnce(limited(header));
  await expect(read()).rejects.toMatchObject({ retryAfterMs: 1000 });
  await vi.advanceTimersByTimeAsync(999);
  await expect(read()).rejects.toMatchObject({ retryAfterMs: 1 });
  expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await read();
  expect(fetcher).toHaveBeenCalledTimes(2);
});


it("delivers snapshot clocks for the actual source and drops responses from a previous owner", async () => {
  const target = new EventTarget(); vi.stubGlobal("window", target);
  const received: any[] = [];
  target.addEventListener("loop-workspace-clock", event => received.push((event as CustomEvent).detail));
  const response = (epoch: string) => Response.json([], { headers: {
    "x-loop-change-epoch": epoch, "x-loop-change-cursor": "19", "x-loop-server-now": "1000", "x-loop-next-deadline": "2000",
  } });
  fetcher.mockImplementation(async () => response("epoch"));
  await read("docker:one");
  await read("docker:one", "/social");
  expect(received.map(value => value.source)).toEqual(["docker:one", ""]);
  expect(received[0].clock).toEqual({ epoch: "epoch", cursor: 19, serverNow: 1000, nextDeadline: 2000 });
  let finish!: (response: Response) => void;
  fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const old = read("docker:one");
  setViewOwner("bob"); finish(response("obsolete")); await old;
  expect(received).toHaveLength(2);
});

it("recovers a signal-driven snapshot from a transient server error without retrying its actions or hiding a permanent refusal",async()=>{
 fetcher.mockResolvedValueOnce(new Response('{"error":"Temporary failure"}',{status:503}));
 const retry=vi.fn(), controller=new AbortController();
 const pending=readInWorkspace("/scheduled-sends","",controller.signal,retry);
 await vi.advanceTimersByTimeAsync(0);
 expect(retry).toHaveBeenCalledWith(expect.objectContaining({status:503}));
 await vi.advanceTimersByTimeAsync(2000);await expect(pending).resolves.toEqual({});
 fetcher.mockImplementation(async () => new Response('{"error":"Still unavailable"}',{status:503}));
 const failed=readInWorkspace("/scheduled-sends","",controller.signal).catch(error=>error);
 await vi.advanceTimersByTimeAsync(6000);expect((await failed).status).toBe(503);
 const before=fetcher.mock.calls.length;await vi.advanceTimersByTimeAsync(30000);expect(fetcher).toHaveBeenCalledTimes(before);
});

it.each(["<html>Gateway unavailable</html>", ""])("retries non-JSON 503 reads (%s) without replaying a write", async body => {
  fetcher.mockResolvedValueOnce(new Response(body, {status:503}));
  const pending = readInWorkspace("/runs/completed/files", "", new AbortController().signal);
  const outcome = pending.catch(error => error);
  await vi.advanceTimersByTimeAsync(2000);
  expect(await outcome).toEqual({});
  expect(fetcher).toHaveBeenCalledTimes(2);
  fetcher.mockResolvedValueOnce(new Response(body, {status:503}));
  await expect(apiInWorkspace("/agents", "", {input:"once"})).rejects.toMatchObject({status:503});
  await vi.advanceTimersByTimeAsync(6000);
  expect(fetcher).toHaveBeenCalledTimes(3);
});
