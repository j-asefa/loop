import { expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { SharedCodex } from "../runtime/shared-codex.ts";

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  const requests: { id: string }[] = [];
  child.stdin.on("data", (chunk) => requests.push(JSON.parse(chunk.toString())));
  const stop = vi.fn();
  const retired = vi.fn();
  const worker = new SharedCodex(child, stop, retired);
  const run = () => worker.run({ action: "turn", input: {} }, vi.fn());
  const send = (index: number, event: object) =>
    child.stdout.write(JSON.stringify({ id: requests[index].id, event }) + "\n");
  return { child, worker, run, send, stop, retired };
}

it("retires a failed Codex worker before its process-close event can arrive", async () => {
  const { child, worker, run, send, stop, retired } = fixture();
  const outcomes = Promise.allSettled([run(), run()]);
  try {
    send(0, {
      code: "runtime_failure",
      error: "Runtime exited before completion (exit code 42).",
      diagnostic: { phase: "process", exitCode: 42 },
    });
    expect(worker.closed).toBe(true);
    expect(retired).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(worker.operations.size).toBe(0);
    for (const outcome of await outcomes)
      expect(outcome).toMatchObject({
        status: "rejected",
        reason: { details: { phase: "process", exitCode: 42 } },
      });
    await expect(run()).rejects.toThrow("Shared Codex runtime is closed");
    child.emit("close", 1, null);
    expect(retired).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  } finally {
    worker.close();
    await outcomes;
  }
});

it("keeps sibling turns and the worker alive after an individual turn failure", async () => {
  const { worker, run, send, stop, retired } = fixture();
  const outcomes = Promise.allSettled([run(), run()]);
  try {
    send(0, {
      code: "runtime_failure",
      error: "Turn failed",
      diagnostic: { phase: "turn" },
    });
    send(0, { finished: true });
    expect(worker.closed).toBe(false);
    expect(worker.operations.size).toBe(1);
    expect(retired).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    send(1, { done: true });
    send(1, { finished: true });
    expect(await outcomes).toMatchObject([
      { status: "rejected", reason: { details: { phase: "turn" } } },
      { status: "fulfilled" },
    ]);
  } finally {
    worker.close();
    await outcomes;
  }
});
