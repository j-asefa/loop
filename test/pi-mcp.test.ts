import { expect, it, vi } from "vitest";
import { registerManagedPiMcp } from "../native/pi-mcp";
function setup(fail = false) {
  const handlers: Record<string, (...args: any[]) => any> = {};
  const tools: any[] = [];
  let scope = { gatewayUrl: "http://localhost/mcp", gatewayToken: "private-token", generation: 1 };
  const peer = {
    listTools: vi.fn(async () => { if (fail) throw new Error("private-token"); return { tools: [{ name: "loop_plan", inputSchema: { type: "object" } }] }; }),
    callTool: vi.fn(async (..._args: any[]) => ({ content: [{ type: "text", text: "done" }] })),
    close: vi.fn(async () => {}),
  };
  const report = vi.fn();
  registerManagedPiMcp({ on: (event, fn) => { handlers[event] = fn; }, registerTool: (tool) => tools.push(tool) }, () => scope, async () => peer, report);
  return { handlers, tools, peer, report, fence: () => { scope = { ...scope, generation: 2 }; } };
}
it("registers scoped tools, forwards cancellation and closes on shutdown", async () => {
  const x = setup();
  await x.handlers.session_start();
  expect(x.report).toHaveBeenCalledWith(true);
  expect(x.handlers.input()).toEqual({ action: "continue" });
  const signal = new AbortController().signal;
  expect(await x.tools[0].execute("native-id", { title: "test" }, signal)).toEqual({ content: [{ type: "text", text: "done" }], details: { workspace: true } });
  expect(x.peer.callTool).toHaveBeenCalledWith("loop_plan", { title: "test" }, signal);
  expect(JSON.stringify(x.tools)).not.toContain("private-token");
  await x.handlers.session_shutdown();
  expect(x.peer.close).toHaveBeenCalledTimes(1);
  expect(x.handlers.input()).toEqual({ action: "handled" });
});
it("refuses prompts and tools after discovery failure or generation change", async () => {
  const failed = setup(true);
  await failed.handlers.session_start();
  expect(failed.handlers.input()).toEqual({ action: "handled" });
  expect(failed.report).toHaveBeenCalledWith(false);
  expect(failed.tools).toHaveLength(0);
  expect(failed.peer.close).toHaveBeenCalledTimes(1);
  const x = setup();
  await x.handlers.session_start();
  x.fence();
  await expect(x.tools[0].execute("id", {})).rejects.toThrow(/fenced/);
  expect(x.peer.callTool).not.toHaveBeenCalled();
});
it("never retries unknown effects or exposes gateway errors", async () => {
  const x = setup();
  await x.handlers.session_start();
  x.peer.callTool.mockRejectedValueOnce(new Error("private-token"));
  await expect(x.tools[0].execute("id", {})).rejects.toThrow(/inspect its outcome/);
  expect(x.peer.callTool).toHaveBeenCalledTimes(1);
});
it("rejects repeated catalog cursors before registering tools", async () => {
  const x = setup();
  x.peer.listTools.mockResolvedValue({ tools: [], nextCursor: "repeat" } as any);
  await x.handlers.session_start();
  expect(x.peer.listTools).toHaveBeenCalledTimes(2);
  expect(x.handlers.input()).toEqual({ action: "handled" });
  expect(x.tools).toHaveLength(0);
});
