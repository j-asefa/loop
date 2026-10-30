import test from "node:test";
import assert from "node:assert/strict";
import { Codex } from "../src/adapters/codex.js";
import { Claude } from "../src/adapters/claude.js";
import { Pi } from "../src/adapters/pi.js";
import { OpenCode } from "../src/adapters/opencode.js";
import { Muse } from "../src/adapters/muse.js";
import { Acp } from "../src/adapters/acp.js";
import { Gemini } from "../src/adapters/gemini.js";
import { Grok } from "../src/adapters/grok.js";
import { Antigravity } from "../src/adapters/antigravity.js";
import { NotDelivered } from "../src/adapters/types.js";

const options = {
  executable: "isolated-transport-fixture",
  project: "/fixture",
  version: "fixture",
  billing: "existing" as const,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const denied = () => {
  throw new Error("fixture authorization revoked");
};

for (const boundary of ["account/read", "config/read"]) {
  test(`Codex rechecks dispatch after ${boundary}`, async () => {
    const adapter: any = new Codex(
      { ...options, harness: "codex", billing: "subscription" },
      () => {},
    );
    const waiting = deferred<void>(),
      release = deferred<void>();
    let revoked = false;
    const calls: string[] = [];
    adapter.native = {
      request: async (method: string) => {
        calls.push(method);
        if (method === boundary) {
          waiting.resolve();
          await release.promise;
        }
        if (method === "account/read") return { account: { type: "chatgpt" } };
        if (method === "config/read") return { config: {} };
        return { turn: { id: "unexpected" } };
      },
    };
    const result = adapter.prompt("must not dispatch", () => {
      if (revoked) denied();
    });
    await waiting.promise;
    revoked = true;
    release.resolve();
    await assert.rejects(result, /authorization revoked/);
    assert(!calls.includes("turn/start"));
  });
}

test("Claude rechecks a follow-up after interruption confirmation", async () => {
  const adapter: any = new Claude({ ...options, harness: "claude" }, () => {});
  const waiting = deferred<void>();
  const writes: unknown[] = [];
  let revoked = false;
  adapter.active = true;
  adapter.control = async () => {
    waiting.resolve();
  };
  adapter.native = {
    write: async (value: unknown) => {
      writes.push(value);
    },
  };
  const result = adapter.steer("must not dispatch", () => {
    if (revoked) denied();
  });
  await waiting.promise;
  revoked = true;
  adapter.steering.result();
  await assert.rejects(result, /authorization revoked/);
  assert.equal(writes.length, 0);
});

test("Pi rechecks after metadata and after its steering queue", async () => {
  const adapter: any = new Pi({ ...options, harness: "pi" }, () => {});
  const metadata = deferred<void>(),
    waiting = deferred<void>();
  const inputs: string[] = [];
  let revoked = false;
  adapter.waitInfo = () => metadata.promise;
  adapter.checkBilling = () => {};
  adapter.native = {
    request: async (_method: string, body: { message?: string }) => {
      if (body.message) inputs.push(body.message);
      waiting.resolve();
      return { isStreaming: true };
    },
  };
  const prompt = adapter.prompt("must not dispatch", () => {
    if (revoked) denied();
  });
  await waiting.promise;
  revoked = true;
  metadata.resolve();
  await assert.rejects(prompt, /authorization revoked/);
  assert.deepEqual(inputs, ["/loop55-status"]);
  const queue = deferred<void>();
  adapter.steering = queue.promise;
  adapter.turnActive = true;
  revoked = false;
  const steer = adapter.steer("must not steer", () => {
    if (revoked) denied();
  });
  revoked = true;
  queue.resolve();
  await assert.rejects(steer, /authorization revoked/);
  assert.deepEqual(inputs, ["/loop55-status"]);
});

for (const otherMessage of [false, true])
  test(`Pi leaves guarded unconfirmed native input queued with concurrent input=${otherMessage}`, async () => {
    const adapter: any = new Pi({ ...options, harness: "pi" }, () => {});
    const waiting = deferred<void>(),
      release = deferred<void>();
    const calls: string[] = [],
      queue: string[] = [];
    let revoked = false;
    adapter.turnActive = true;
    adapter.native = {
      request: async (method: string, input: { message?: string }) => {
        calls.push(method);
        if (method === "steer") queue.push(input.message!);
        if (method === "get_state") {
          waiting.resolve();
          await release.promise;
          // A native writer can race with this stale queue count. Its input
          // has no Loop55 authorization token and must retain its native owner.
          if (otherMessage) queue.push("native input");
          return { isStreaming: false, pendingMessageCount: 1 };
        }
        if (method === "clear_queue")
          return { steering: queue.splice(0), followUp: [] };
        return {};
      },
    };
    const result = adapter.steer("guarded input", () => {
      if (revoked) denied();
    });
    await waiting.promise;
    revoked = true;
    release.resolve();
    await assert.rejects(
      result,
      (error: unknown) =>
        error instanceof Error &&
        !(error instanceof NotDelivered) &&
        /queued/.test(error.message),
    );
    assert.deepEqual(calls, ["steer", "get_state"]);
    assert.deepEqual(queue, [
      "guarded input",
      ...(otherMessage ? ["native input"] : []),
    ]);
  });

test("OpenCode rechecks after reading the previous message boundary", async () => {
  const adapter: any = new OpenCode(
    { ...options, harness: "opencode" },
    () => {},
  );
  const waiting = deferred<void>(),
    release = deferred<void>();
  const writes: string[] = [];
  let revoked = false;
  adapter.api = async (path: string, body?: unknown) => {
    if (body) writes.push(path);
    else {
      waiting.resolve();
      await release.promise;
    }
    return [];
  };
  const result = adapter.prompt("must not dispatch", () => {
    if (revoked) denied();
  });
  await waiting.promise;
  revoked = true;
  release.resolve();
  await assert.rejects(result, /authorization revoked/);
  assert.deepEqual(writes, []);
});

test("Muse rechecks after applying a pending model before starting a turn", async () => {
  const adapter: any = new Muse(
    { ...options, harness: "muse", model: "next" },
    () => {},
  );
  const waiting = deferred<void>(),
    release = deferred<void>();
  const calls: string[] = [];
  let revoked = false;
  adapter.native = {
    request: async (method: string) => {
      calls.push(method);
      if (method === "session/setModel") {
        waiting.resolve();
        await release.promise;
      }
      return {};
    },
  };
  const result = adapter.prompt("must not dispatch", () => {
    if (revoked) denied();
  });
  await waiting.promise;
  revoked = true;
  release.resolve();
  await assert.rejects(result, /authorization revoked/);
  assert.deepEqual(calls, ["session/setModel"]);
});

for (const [harness, Adapter] of [
  ["acp", Acp],
  ["gemini", Gemini],
  ["grok", Grok],
  ["antigravity", Antigravity],
] as const) {
  test(`${harness} refuses a prompt before native dispatch`, async () => {
    const adapter: any = new Adapter({ ...options, harness }, () => {});
    let writes = 0;
    adapter.session = "fixture";
    adapter.native = {
      write: async () => {
        writes++;
      },
    };
    adapter.connection = {
      prompt: async () => {
        writes++;
        return { stopReason: "end_turn" };
      },
    };
    await assert.rejects(
      adapter.prompt("must not dispatch", denied),
      /authorization revoked/,
    );
    assert.equal(writes, 0);
  });
}

test("Codex async answers retain their question when a late guard refuses dispatch", async () => {
  const adapter: any = new Codex(
    { ...options, harness: "codex", billing: "subscription" },
    () => {},
  );
  const waiting = deferred<void>(),
    release = deferred<void>();
  let revoked = false;
  const calls: string[] = [];
  adapter.asyncQuestions.set("question", {
    questions: [{ id: "q", title: "Continue?" }],
  });
  adapter.native = {
    request: async (method: string) => {
      calls.push(method);
      if (method === "account/read") {
        waiting.resolve();
        await release.promise;
        return { account: { type: "chatgpt" } };
      }
      if (method === "config/read") return { config: {} };
      return { turn: { id: "unexpected" } };
    },
  };
  const result = adapter.answer("question", { q: ["yes"] }, () => {
    if (revoked) denied();
  });
  await waiting.promise;
  revoked = true;
  release.resolve();
  await assert.rejects(result, /authorization revoked/);
  assert(!calls.includes("turn/start"));
  assert(adapter.asyncQuestions.has("question"));
});

for (const [harness, Adapter] of [
  ["codex", Codex],
  ["claude", Claude],
  ["pi", Pi],
  ["opencode", OpenCode],
  ["muse", Muse],
  ["acp", Acp],
] as const) {
  test(`${harness} preserves a pending answer when the dispatch guard refuses`, async () => {
    const adapter: any = new Adapter({ ...options, harness }, () => {});
    let writes = 0;
    adapter.native = {
      write: async () => {
        writes++;
      },
      request: async () => {
        writes++;
        return {};
      },
    };
    adapter.api = async () => {
      writes++;
      return {};
    };
    if (harness === "acp")
      adapter.permissions.set("decision", {
        choices: new Set(["allow"]),
        resolve: () => {
          writes++;
        },
      });
    else if (harness === "muse")
      adapter.approvals.set("approval", {
        requestId: "decision",
        choices: new Map([["allow", "choice"]]),
        answered: false,
      });
    else
      adapter.requests.set("decision", {
        id: "native-id",
        method: "item/commandExecution/requestApproval",
        params: {},
        request: { tool_name: "Shell", input: {} },
        m: { method: "confirm" },
        type: "permission.asked",
      });
    await assert.rejects(
      adapter.answer("decision", { choice: "allow" }, denied),
      /authorization revoked/,
    );
    assert.equal(writes, 0);
    if (harness === "acp") assert(adapter.permissions.has("decision"));
    else if (harness === "muse")
      assert.equal(adapter.approvals.get("approval").answered, false);
    else assert(adapter.requests.has("decision"));
  });
}
