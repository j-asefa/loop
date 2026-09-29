import { expect, it } from "vitest";
import { CodexSession } from "../runtime/codex-session.mjs";
import { RuntimeFailure } from "../runtime/diagnostics.mjs";

it("does not start inference when cancelled during skill discovery", async () => {
  const controller = new AbortController();
  const calls = [];
  let finishDiscovery;
  let discoveryStarted;
  const discovery = new Promise((resolve) => {
    discoveryStarted = resolve;
  });
  // Exercise the real session and harness with a manually released RPC response.
  const session = Object.assign(Object.create(CodexSession.prototype), {
    ready: Promise.resolve(),
    hostMode: true,
    cwd: "/fixture",
    threads: new Map(),
    rpc: {
      async call(method, params) {
        calls.push({ method, params });
        if (method === "account/read") return { account: { type: "chatgpt" } };
        if (method === "thread/start")
          return { thread: { id: "thread-fixture" } };
        if (method === "skills/list") {
          return new Promise((resolve) => {
            finishDiscovery = resolve;
            discoveryStarted();
          });
        }
        if (method === "turn/start") return { turn: { id: "turn-fixture" } };
        return {};
      },
    },
  });
  const run = session.run(
    {
      action: "turn",
      input: { messages: [{ role: "user", content: "$fixture-skill help" }] },
    },
    () => {},
    controller.signal,
    () => {},
  );
  await discovery;
  const reason = new Error("User stopped during discovery");
  controller.abort(reason);
  finishDiscovery({
    data: [{ skills: [{ name: "fixture-skill", path: "/fixture/SKILL.md" }] }],
  });
  await expect(run).rejects.toBe(reason);
  expect(calls.map(({ method }) => method)).toEqual([
    "account/read",
    "thread/start",
    "skills/list",
    "thread/unsubscribe",
  ]);
  expect(calls.at(-1).params).toEqual({ threadId: "thread-fixture" });
  expect(session.threads.size).toBe(0);
});

it("retries a transient Codex routing discovery failure before starting work", async () => {
  const calls = [];
  const emitted = [];
  const session = Object.assign(Object.create(CodexSession.prototype), {
    ready: Promise.resolve(),
    hostMode: true,
    cwd: "/fixture",
    threads: new Map(),
    rpc: {
      async call(method, params) {
        calls.push({ method, params });
        if (method === "account/read" && calls.length === 1)
          throw new RuntimeFailure(
            "Codex rejected account/read: workspace routing discovery failed",
            { phase: "account/read" },
          );
        if (method === "account/read") return { account: { type: "chatgpt" } };
        if (method === "model/list") return { data: [] };
        return {};
      },
    },
  });
  await session.run(
    { action: "status" },
    (event) => emitted.push(event),
    new AbortController().signal,
    () => {},
  );
  expect(calls.map(({ method }) => method)).toEqual([
    "account/read",
    "account/read",
    "model/list",
    "account/rateLimits/read",
  ]);
  expect(emitted[0].result.authenticated).toBe(true);
});
