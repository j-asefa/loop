import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { waitForPiTools } from "../native/pi-readiness";

it("accepts fragmented private readiness and removes listeners", async () => {
  const pipe = new PassThrough();
  const result = waitForPiTools(pipe, 100);
  pipe.write('{"type":"loop-mcp-');
  pipe.write('ready","ready":true}\n');
  await result;
  expect(pipe.listenerCount("data")).toBe(0);
  pipe.destroy();
});

it("refuses negative, malformed, oversized and missing readiness", async () => {
  for (const payload of ['{"type":"loop-mcp-ready","ready":false}\n', '{"ready":true}\n', 'sensitive content\n', 'x'.repeat(1025)]) {
    const pipe = new PassThrough();
    const check = expect(waitForPiTools(pipe, 100)).rejects.toThrow("Managed Pi workspace tools failed to initialize");
    pipe.end(payload);
    await check;
    expect(pipe.listenerCount("data")).toBe(0);
    pipe.destroy();
  }
  const pipe = new PassThrough();
  await expect(waitForPiTools(pipe, 5)).rejects.toThrow("failed to initialize");
  pipe.destroy();
});

it("refuses a closed private channel immediately", async () => {
  const pipe = new PassThrough();
  pipe.destroy();
  await expect(waitForPiTools(pipe, 100)).rejects.toThrow("failed to initialize");
});
