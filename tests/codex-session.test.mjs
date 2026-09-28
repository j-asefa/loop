import { expect, it } from "vitest";
import { CodexSession } from "../runtime/codex-session.mjs";

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
