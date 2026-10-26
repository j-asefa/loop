import { EventEmitter } from "node:events";
import { it, expect } from "vitest";
import { inspectCodexAppServer } from "../native/codex-app-server-status.mjs";

class FixtureSocket extends EventEmitter {
  static last;
  constructor(endpoint, options) {
    super();
    this.endpoint = endpoint;
    this.options = options;
    this.requests = [];
    FixtureSocket.last = this;
    queueMicrotask(() => this.emit("open"));
  }
  send(raw) {
    const message = JSON.parse(raw);
    if (!message.id) return;
    this.requests.push(message.method);
    const results = {
      initialize: {},
      "account/read": { account: { type: "chatgpt" } },
      "config/read": {
        config: { forced_login_method: "chatgpt", model_provider: "openai" },
      },
      "model/list": { data: [{ model: "codex-latest", displayName: "Codex" }] },
    };
    queueMicrotask(() =>
      this.emit(
        "message",
        Buffer.from(
          JSON.stringify({ id: message.id, result: results[message.method] }),
        ),
      ),
    );
  }
  close() {
    queueMicrotask(() => this.emit("close"));
  }
}

it("reads subscription status and models over the worker's existing app-server", async () => {
  const status = await inspectCodexAppServer({
    endpoint: "ws://127.0.0.1:3014",
    token: "worker-scoped-capability",
    WebSocketCtor: FixtureSocket,
  });
  expect(status.authenticated).toBe(true);
  expect(status.models).toEqual([
    { id: "codex-latest", name: "Codex", capabilities: "Native Codex" },
  ]);
  expect(FixtureSocket.last.endpoint).toBe("ws://127.0.0.1:3014");
  expect(FixtureSocket.last.options.headers.Authorization).toBe(
    "Bearer worker-scoped-capability",
  );
  expect(FixtureSocket.last.requests).toEqual([
    "initialize",
    "account/read",
    "config/read",
    "model/list",
  ]);
});

it("rejects missing shared-server credentials instead of spawning a fallback", async () => {
  await expect(
    inspectCodexAppServer({
      endpoint: "ws://127.0.0.1:3014",
      WebSocketCtor: FixtureSocket,
    }),
  ).rejects.toThrow("Shared Codex app-server is unavailable");
});
