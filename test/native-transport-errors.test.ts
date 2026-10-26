import { expect, it, vi } from "vitest";
import { Native, NativeTransportError } from "../src/native";
import { nativeStartupFailure } from "../src/server/native/startup-failure";

it("retains the timed-out native method and timeout through the transport", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const native = new Native(process.execPath, ["-e", "process.stdin.resume()"], process.cwd());
  try {
    const result = expect(native.request("thread/resume")).rejects.toMatchObject({
      name: "NativeTransportError", code: "native_request_timeout",
      details: { method: "thread/resume", timeoutMs: 30000 },
    });
    await vi.advanceTimersByTimeAsync(30000);
    await result;
    expect(native.pending.size).toBe(0);
  } finally {
    vi.useRealTimers();
    await native.dispose();
  }
});

it("names the reconnect step without exposing arbitrary method names or error text", () => {
  const error = new NativeTransportError("native_request_timeout", "private context", { method: "thread/resume", timeoutMs: 30000 });
  const failure = nativeStartupFailure("Codex", error, true);
  expect(failure.message).toContain("reopening this conversation");
  expect(failure.message).toContain("No prompt was sent");
  expect(failure.diagnostic).toMatchObject({ method: "thread/resume", timeoutMs: 30000, promptSent: false });
  error.details.method = "private-token";
  const unknown = nativeStartupFailure("Codex", error, true);
  expect(JSON.stringify({ message: unknown.message, diagnostic: unknown.diagnostic })).not.toContain("private");
});
