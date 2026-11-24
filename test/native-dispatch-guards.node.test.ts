import test from "node:test";
import assert from "node:assert/strict";
import { Codex } from "../src/adapters/codex.js";
import { Claude } from "../src/adapters/claude.js";
import { CANCEL_HOLD_MS, HOLD_MS } from "../src/adapters/claude-steering.js";
import { Pi } from "../src/adapters/pi.js";
import { OpenCode } from "../src/adapters/opencode.js";
import { Muse } from "../src/adapters/muse.js";
import { Acp } from "../src/adapters/acp.js";
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

function liveClaude() {
  const events: any[] = [];
  const adapter: any = new Claude(
    { ...options, harness: "claude" },
    (event: any) => events.push(event),
  );
  const writes: any[] = [];
  const controls: unknown[] = [];
  adapter.active = true;
  adapter.session = "session-1";
  adapter.control = async (request: unknown) => {
    controls.push(request);
  };
  adapter.native = {
    write: async (value: unknown) => {
      writes.push(value);
    },
    dispose: async () => {},
  };
  const echo = (write: any) =>
    adapter.message({ ...write, isReplay: true, session_id: "session-1" });
  const result = (errors?: string[]) =>
    adapter.message({
      type: "result",
      is_error: !!errors,
      ...(errors ? { errors } : {}),
      session_id: "session-1",
      origin: { kind: "human" },
    });
  const statuses = () => events.filter((e) => e.type === "status");
  return { adapter, writes, controls, echo, result, statuses };
}
const settled = (promise: Promise<unknown>) =>
  Promise.race([
    promise.then(
      () => "read",
      () => "rejected",
    ),
    new Promise((done) => setImmediate(() => done("waiting"))),
  ]);

test("Claude checks a follow-up's authorization before writing it", async () => {
  const { adapter, writes, controls } = liveClaude();
  await assert.rejects(
    adapter.steer("must not dispatch", denied),
    /authorization revoked/,
  );
  assert.equal(writes.length, 0);
  assert.equal(controls.length, 0);
});

test("Claude follow-ups join the running turn and confirm on Claude's echo", async () => {
  const { adapter, writes, controls, echo, result, statuses } = liveClaude();
  const steer = adapter.steer("Focus on the tests");
  await new Promise((done) => setImmediate(done));
  assert.equal(controls.length, 0, "a follow-up never interrupts the turn");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].message.content, "Focus on the tests");
  echo({ ...writes[0], uuid: "another-message" });
  assert.equal(await settled(steer), "waiting", "only its own echo confirms");
  echo(writes[0]);
  assert.equal(await settled(steer), "read");
  result();
  assert.deepEqual(
    statuses().map((e) => e.status),
    ["completed"],
  );
});

test("Claude keeps the run open when a turn ends before it reads a follow-up", async () => {
  const { adapter, writes, echo, result, statuses } = liveClaude();
  const steer = adapter.steer("Side question");
  await new Promise((done) => setImmediate(done));
  result();
  assert.equal(statuses().length, 0, "the unread follow-up gets a turn");
  assert.equal(adapter.active, true);
  echo(writes[0]);
  assert.equal(await settled(steer), "read");
  result();
  assert.deepEqual(
    statuses().map((e) => e.status),
    ["completed"],
  );
});

test("Claude keeps a cancelled run open for the turn that answers its follow-up, then stops it", async () => {
  // Observed on Claude Code 2.1.237 and 2.1.325: after an interrupt Claude
  // still reads an unread follow-up and answers it in a further turn.
  const { adapter, writes, controls, echo, result, statuses } = liveClaude();
  const steer = adapter.steer("Side question");
  await new Promise((done) => setImmediate(done));
  await adapter.cancel();
  result(["interrupted"]);
  assert.equal(statuses().length, 0, "the follow-up's turn is still to come");
  echo(writes[0]);
  assert.equal(await settled(steer), "read");
  await new Promise((done) => setImmediate(done));
  assert.equal(
    controls.filter((c: any) => c.subtype === "interrupt").length,
    2,
    "the follow-up's turn is interrupted too",
  );
  result();
  assert.deepEqual(
    statuses().map((e) => [e.status, e.detail]),
    [["interrupted", "interrupted"]],
  );
  assert.equal(writes.length, 1, "the follow-up is never written again");
});

function heldPastFallback(t: any) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const live = liveClaude();
  const steer = live.adapter.steer("Side question");
  return { ...live, steer };
}

test("Claude ends a held run when no echo follows, and stops that follow-up's late turn", async (t) => {
  const { adapter, writes, controls, echo, result, statuses, steer } =
    heldPastFallback(t);
  await new Promise((done) => setImmediate(done));
  result(["first turn failed"]);
  assert.equal(statuses().length, 0);
  t.mock.timers.tick(HOLD_MS);
  await assert.rejects(steer, /Claude stopped before confirming/);
  assert.deepEqual(
    statuses().map((e) => [e.status, e.detail]),
    [["failed", "first turn failed"]],
  );
  // The next prompt is written before Claude reads the abandoned follow-up.
  await adapter.prompt("Next prompt");
  const next = writes.at(-1);
  echo(writes[0]);
  await new Promise((done) => setImmediate(done));
  assert.equal(
    controls.filter((c: any) => c.subtype === "interrupt").length,
    1,
    "the orphan turn is stopped even with a newer prompt written",
  );
  adapter.message({
    type: "control_request",
    request_id: "orphan-permission",
    request: { subtype: "can_use_tool", tool_name: "Bash", input: {} },
  });
  assert.equal(writes.at(-1).response.response.behavior, "deny");
  // A background task's result does not end the orphan turn.
  adapter.message({
    type: "result",
    is_error: false,
    session_id: "session-1",
    origin: { kind: "task-notification" },
  });
  result();
  assert.equal(statuses().length, 1, "the orphan turn's result is ignored");
  echo(next);
  result();
  assert.deepEqual(
    statuses().map((e) => e.status),
    ["failed", "completed"],
  );
});

test("Claude gives a prompt read inside an orphan turn the rest of that turn", async (t) => {
  const { adapter, writes, echo, result, statuses, steer } =
    heldPastFallback(t);
  await new Promise((done) => setImmediate(done));
  result();
  t.mock.timers.tick(HOLD_MS);
  await assert.rejects(steer);
  await adapter.prompt("Next prompt");
  const next = writes.at(-1);
  echo(writes[0]);
  echo(next); // Claude reads the prompt at a tool boundary of the orphan turn.
  result();
  assert.deepEqual(
    statuses().map((e) => e.status),
    ["completed", "completed"],
  );
});

test("Claude stops a cancelled prompt that Claude reads after an orphan turn", async (t) => {
  const { adapter, writes, controls, echo, result, statuses, steer } =
    heldPastFallback(t);
  await new Promise((done) => setImmediate(done));
  result();
  t.mock.timers.tick(HOLD_MS);
  await assert.rejects(steer);
  await adapter.prompt("Next prompt");
  const next = writes.at(-1);
  echo(writes[0]); // the orphan turn starts and is interrupted
  await adapter.cancel(); // lands on the orphan turn too
  result(); // the orphan turn's result
  echo(next); // Claude then reads the cancelled prompt
  await new Promise((done) => setImmediate(done));
  assert.equal(
    controls.filter((c: any) => c.subtype === "interrupt").length,
    3,
    "the cancelled prompt's turn is interrupted when it starts",
  );
  result();
  assert.deepEqual(
    statuses().map((e) => e.status),
    ["completed", "interrupted"],
  );
});

test("Claude holds a cancelled run for less than the supervisor's interrupt deadline", async (t) => {
  const { adapter, result, statuses, steer } = heldPastFallback(t);
  await new Promise((done) => setImmediate(done));
  await adapter.cancel();
  result();
  t.mock.timers.tick(CANCEL_HOLD_MS);
  assert.deepEqual(
    statuses().map((e) => e.status),
    ["interrupted"],
  );
  await assert.rejects(steer);
  assert(CANCEL_HOLD_MS < 10_000);
});

test("Claude ends a held run at once when the only unread follow-up's write fails", async () => {
  const { adapter, result, statuses } = liveClaude();
  let fail!: (error: Error) => void;
  let sent: any;
  adapter.native.write = (value: unknown) =>
    new Promise((_, reject) => {
      sent = value;
      fail = reject;
    });
  const steer = adapter.steer("Side question");
  await new Promise((done) => setImmediate(done));
  result(["held turn failed"]);
  assert.equal(statuses().length, 0);
  fail(new Error("pipe closed"));
  await assert.rejects(steer, /pipe closed/);
  assert.deepEqual(
    statuses().map((e) => [e.status, e.detail]),
    [["failed", "held turn failed"]],
  );
  // The failed write may still have reached Claude.
  adapter.message({ type: "user", isReplay: true, uuid: sent.uuid });
  assert.equal(adapter.orphanTurn, true);
});

test("Claude leaves no unhandled rejection when a follow-up is abandoned mid-write", async () => {
  const { adapter, statuses } = liveClaude();
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", record);
  try {
    let fail!: (error: Error) => void;
    adapter.native.write = () =>
      new Promise((_, reject) => {
        fail = reject;
      });
    const steer = adapter.steer("Side question");
    await new Promise((done) => setImmediate(done));
    await adapter.dispose();
    await new Promise((done) => setTimeout(done, 10));
    fail(new Error("pipe closed"));
    await assert.rejects(steer, /pipe closed/);
    await new Promise((done) => setTimeout(done, 10));
    assert.deepEqual(unhandled, []);
    assert.equal(statuses().length, 0);
  } finally {
    process.off("unhandledRejection", record);
  }
});

test("Claude leaves an unread follow-up unconfirmed after dispose", async () => {
  const { adapter, writes } = liveClaude();
  const steer = adapter.steer("Side question");
  await new Promise((done) => setImmediate(done));
  await adapter.dispose();
  await assert.rejects(steer, /Claude closed before confirming/);
  assert.equal(writes.length, 1, "the follow-up is never written again");
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
  assert.deepEqual(inputs, ["/loop-status"]);
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
  assert.deepEqual(inputs, ["/loop-status"]);
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
          // has no Loop authorization token and must retain its native owner.
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

for (const [harness, Adapter, version = options.version] of [
  ["acp", Acp],
  ["grok", Grok],
  ["antigravity", Antigravity, "1.4.9"],
  ["antigravity", Antigravity, "1.5.9"],
] as const) {
  test(`${harness} ${version} refuses a prompt before native dispatch`, async () => {
    const adapter: any = new Adapter(
      { ...options, harness, version },
      () => {},
    );
    const transport = harness === "antigravity" ? adapter.adapter : adapter;
    let writes = 0;
    transport.session = "fixture";
    transport.native = {
      write: async () => {
        writes++;
      },
    };
    transport.connection = {
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
