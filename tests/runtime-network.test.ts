import { afterEach, expect, it, vi } from "vitest";
const { remoteFetch } = vi.hoisted(() => ({ remoteFetch: vi.fn() }));
vi.mock("undici", async (original) => ({
  ...(await original<typeof import("undici")>()),
  fetch: remoteFetch,
}));
const { safeFetch, safeRuntimeFetch } =
  await import("../src/server/mcp/network");
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
