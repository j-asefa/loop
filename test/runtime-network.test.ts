import { afterAll, afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const directory = mkdtempSync(join(tmpdir(), "loop55-runtime-network-"));
process.env.LOOP55_DATA_DIR = directory;
const { remoteFetch } = vi.hoisted(() => ({ remoteFetch: vi.fn() }));
vi.mock("undici", async (original) => ({
  ...(await original<typeof import("undici")>()),
  fetch: remoteFetch,
}));
const { safeFetch, safeRuntimeFetch } =
  await import("../src/server/mcp/network");
afterAll(async () => {
  const { db } = await import("../src/server/db");
  db.close();
  rmSync(directory, { recursive: true, force: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  remoteFetch.mockReset();
});

it("allows a runtime stream beyond 30 minutes and 4 MB while preserving caller cancellation", async () => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("Fixture timeout")), ms);
    return controller.signal;
  });
  const caller = new AbortController();
  let source!: ReadableStreamDefaultController<Uint8Array>;
  remoteFetch.mockImplementation(
    async (_url, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            source = controller;
            init.signal.addEventListener(
              "abort",
              () => controller.error(init.signal.reason),
              { once: true },
            );
          },
        }),
      ),
  );
  const response = await safeRuntimeFetch("https://runtime.example/runtime", {
    signal: caller.signal,
  });
  const reader = response.body!.getReader();
  // Each chunk is small; the entire long-lived stream is larger than an MCP result.
  for (let i = 0; i < 512; i++) {
    source.enqueue(new Uint8Array(12000));
    expect((await reader.read()).value?.byteLength).toBe(12000);
  }
  await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
  source.enqueue(new Uint8Array([10]));
  expect((await reader.read()).value).toEqual(new Uint8Array([10]));
  const stopped = expect(reader.read()).rejects.toThrow("Cancelled by caller");
  caller.abort(new Error("Cancelled by caller"));
  await stopped;
});

it("retains the 4 MB response limit for ordinary MCP requests", async () => {
  remoteFetch.mockResolvedValue(
    new Response(new Uint8Array(4 * 1024 * 1024 + 1)),
  );
  const response = await safeFetch("https://tools.example/mcp");
  await expect(response.arrayBuffer()).rejects.toThrow(
    "MCP response exceeds 4 MB",
  );
});

it("gives long MCP calls their configured timeout without losing caller cancellation", async () => {
  const { safeToolFetch } = await import("../src/server/mcp/network");
  const { MCP_TOOL_TIMEOUT_MS } = await import("../src/server/mcp/timeouts");
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("Tool deadline")), ms);
    return controller.signal;
  });
  let signal!: AbortSignal;
  remoteFetch.mockImplementation(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        signal = init.signal;
        expect(init.bodyTimeout).toBe(MCP_TOOL_TIMEOUT_MS);
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  );
  const caller = new AbortController();
  const pending = safeToolFetch("https://tools.example/mcp", {
    signal: caller.signal,
  });
  const stopped = expect(pending).rejects.toThrow("Explicit cancellation");
  await vi.advanceTimersByTimeAsync(90000);
  expect(signal.aborted).toBe(false);
  caller.abort(new Error("Explicit cancellation"));
  await stopped;
});

it.each([safeFetch, safeRuntimeFetch])(
  "preserves cancellation carried by a Request object",
  async (fetcher) => {
    const caller = new AbortController();
    remoteFetch.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          if (init.signal.aborted) reject(init.signal.reason);
          else
            init.signal.addEventListener(
              "abort",
              () => reject(init.signal.reason),
              { once: true },
            );
        }),
    );
    const pending = fetcher(
      new Request("https://tools.example/mcp", { signal: caller.signal }),
    );
    const stopped = expect(pending).rejects.toThrow("Request cancelled");
    caller.abort(new Error("Request cancelled"));
    await stopped;
  },
);

it("lets an explicit init signal override a Request signal", async () => {
  const original = new AbortController();
  original.abort();
  const replacement = new AbortController();
  remoteFetch.mockImplementation(async (_url, init) => {
    expect(init.signal.aborted).toBe(false);
    return new Response("ok");
  });
  const response = await safeFetch(
    new Request("https://tools.example/mcp", { signal: original.signal }),
    { signal: replacement.signal },
  );
  expect(await response.text()).toBe("ok");
});
