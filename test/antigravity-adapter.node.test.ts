import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Antigravity } from "../src/adapters/antigravity.js";
import { NativeSetupError } from "../src/adapters/setup-error.js";
import type { AdapterEvent } from "../src/adapters/events.js";
import type { Options } from "../src/adapters/types.js";
import { until } from "./helpers/wait.js";

const options: Options = {
  harness: "antigravity",
  executable: resolve("test/fixtures/fake-antigravity.mjs"),
  project: process.cwd(),
  billing: "existing",
  version: "1.4.9",
};
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "loop-agy-"));
  const path = join(dir, "requests");
  process.env.LOOP_TEST_AGY_LOG = path;
  t.after(() => {
    delete process.env.LOOP_TEST_AGY_LOG;
    delete process.env.LOOP_TEST_AGY_MODE;
    rmSync(dir, { recursive: true, force: true });
  });
  return () => [...read(path), ...read(`${path}.acp`)];
}
const read = (path: string) =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
const sessions = (requests: () => any[]) =>
  requests().filter((r) => r.args?.includes("--input-format"));
const complete = (events: AdapterEvent[]) =>
  events.filter((e) => e.type === "status" && e.status === "completed");

test("saved Antigravity versions never gain ACP capabilities from an unknown or prerelease version", () => {
  for (const version of ["unknown", "1.5.9-rc.1", "2.0.0-beta.1"]) {
    const adapter = new Antigravity({ ...options, version }, () => {});
    assert.equal(adapter.activityTransport, "native");
    assert.equal(adapter.capabilities.workspaceTools, false);
    assert.equal(adapter.steer, undefined);
    assert.equal(adapter.canReuse({ ...options, version: "1.5.9" }), false);
  }
});

test("Antigravity probes models and native initialization without a prompt, credential access or permission bypass", async (t) => {
  const requests = fixture(t);
  const events: AdapterEvent[] = [];
  const adapter = new Antigravity({ ...options, probeOnly: true }, (e) =>
    events.push(e),
  );
  try {
    assert.equal((await adapter.start()).mode, "existing");
    assert.deepEqual(adapter.models, [
      { id: "gemini-agy-fixture", name: "Gemini fixture" },
      { id: "claude-agy-fixture", name: "Claude fixture" },
    ]);
    assert.equal(adapter.capabilities.approvals, false);
    assert.equal(adapter.capabilities.workspaceTools, false);
    assert.equal(adapter.steer, undefined);
    assert.deepEqual(
      requests()
        .filter((r) => r.args)
        .map((r) => r.args[0])
        .sort(),
      ["--input-format", "acp", "models"],
    );
    // The catalog session only initializes, opens and closes; no prompt.
    assert.deepEqual(
      requests()
        .filter((r) => r.acp)
        .map((r) => r.acp),
      ["initialize", "session/new", "session/close"],
    );
    assert.equal(
      requests().find((r) => r.acp === "session/new").params.cwd,
      process.cwd(),
    );
    assert.deepEqual(adapter.commands, [
      {
        name: "plan",
        token: "/plan",
        kind: "command",
        description: "Plan before executing.",
      },
      {
        name: "antigravity-guide",
        token: "/antigravity-guide",
        kind: "command",
        description: "Guide  to agy.",
      },
    ]);
    assert.deepEqual(events, []);
  } finally {
    await adapter.dispose();
  }
});

test("Antigravity streams explicit turns, tools and per-turn usage and resumes only the exact native conversation", async (t) => {
  const requests = fixture(t);
  const events: AdapterEvent[] = [];
  const adapter = new Antigravity(
    {
      ...options,
      model: "gemini-agy-fixture",
      effort: "high",
      instructions: "Saved instructions",
      workspaceTools: {
        url: "http://127.0.0.1:1234/mcp",
        token: "private-bridge-token",
      },
    },
    (e) => events.push(e),
  );
  try {
    await adapter.start();
    await adapter.prompt("First task");
    await until(() => complete(events).length === 1);
    await adapter.prompt("/logout is literal task text");
    await until(() => complete(events).length === 2);
    assert.deepEqual(
      requests()
        .filter((r) => r.event === "user")
        .map((r) => r.message.content),
      [
        "Saved instructions\n\nFirst task",
        "Saved instructions\n\n/logout is literal task text",
      ],
    );
    const args = sessions(requests)[0].args;
    assert(!args.includes("--disable-slash-commands"));
    assert.equal(args[args.indexOf("--model") + 1], "gemini-agy-fixture");
    assert.equal(args[args.indexOf("--effort") + 1], "high");
    assert(!args.includes("--dangerously-skip-permissions"));
    assert(
      events.some(
        (e) =>
          e.type === "item" &&
          e.item.kind === "tool" &&
          e.item.status === "completed",
      ),
    );
    assert.deepEqual(
      events.filter((e) => e.type === "usage").map((e) => e.usage),
      [
        { input_tokens: 13, output_tokens: 3 },
        { input_tokens: 13, output_tokens: 3 },
      ],
    );
    assert(!JSON.stringify(events).includes("private-"));
    assert(!JSON.stringify(requests()).includes("private-bridge-token"));
    await assert.rejects(adapter.answer(), /does not accept approval/);
  } finally {
    await adapter.dispose();
  }
  const resumed = new Antigravity(
    {
      ...options,
      resume: "agy-fixture-session",
      instructions: "Saved instructions",
    },
    () => {},
  );
  try {
    await resumed.start();
    assert.equal(requests().filter((r) => r.event === "user").length, 2);
    const args = sessions(requests).at(-1).args;
    assert.equal(
      args[args.indexOf("--conversation") + 1],
      "agy-fixture-session",
    );
    assert(!args.includes("--continue"));
    await resumed.prompt("Explicit continuation");
    await until(
      () => requests().filter((r) => r.event === "user").length === 3,
    );
  } finally {
    await resumed.dispose();
  }
});

test("Antigravity leads only with a discovered command and keeps other slash text literal", async (t) => {
  const requests = fixture(t);
  const sent = () =>
    requests()
      .filter((r) => r.event === "user")
      .map((r) => r.message.content);
  for (const instructions of ["Saved instructions", undefined]) {
    const events: AdapterEvent[] = [];
    const adapter = new Antigravity({ ...options, instructions }, (e) =>
      events.push(e),
    );
    try {
      await adapter.start();
      for (const text of [
        "/antigravity-guide explain skills",
        "/help is a CLI command",
        "/tmp/notes.txt summarise this",
        "/planner is not /plan",
      ]) {
        const before = complete(events).length;
        await adapter.prompt(text);
        await until(() => complete(events).length === before + 1);
      }
    } finally {
      await adapter.dispose();
    }
  }
  assert.deepEqual(sent(), [
    "/antigravity-guide explain skills\n\nSaved instructions",
    "Saved instructions\n\n/help is a CLI command",
    "Saved instructions\n\n/tmp/notes.txt summarise this",
    "Saved instructions\n\n/planner is not /plan",
    "/antigravity-guide explain skills",
    "\u200b/help is a CLI command",
    "\u200b/tmp/notes.txt summarise this",
    "\u200b/planner is not /plan",
  ]);
});

test("Antigravity keeps slash-leading saved instructions literal", async (t) => {
  const requests = fixture(t);
  const events: AdapterEvent[] = [];
  const adapter = new Antigravity(
    { ...options, instructions: "/help is how I like reviews" },
    (e) => events.push(e),
  );
  try {
    await adapter.start();
    await adapter.prompt("Review the change");
    await until(() => complete(events).length === 1);
    assert.deepEqual(
      requests()
        .filter((r) => r.event === "user")
        .map((r) => r.message.content),
      ["\u200b/help is how I like reviews\n\nReview the change"],
    );
  } finally {
    await adapter.dispose();
  }
});

test("Antigravity keeps a received catalog when agy does not answer session/close", async (t) => {
  fixture(t);
  process.env.LOOP_TEST_AGY_MODE = "acp-close-hang";
  const adapter = new Antigravity({ ...options, probeOnly: true }, () => {});
  try {
    const started = Date.now();
    await adapter.start();
    assert(Date.now() - started < 4000);
    assert.deepEqual(
      adapter.commands.map((c) => c.name),
      ["plan", "antigravity-guide"],
    );
  } finally {
    await adapter.dispose();
  }
});

test("Antigravity bounds a catalog read by its deadline even when the ACP process is slow to stop", async (t) => {
  fixture(t);
  process.env.LOOP_TEST_AGY_MODE = "acp-hang-slow-stop";
  const probe = new Antigravity({ ...options, probeOnly: true }, () => {});
  try {
    const started = Date.now();
    await probe.start();
    // 5 s discovery deadline; stopping the process (2.5 s grace) is not awaited.
    assert(Date.now() - started < 6500, `${Date.now() - started} ms`);
    assert.deepEqual(probe.commands, []);
  } finally {
    await probe.dispose();
  }
  const adapter = new Antigravity(options, () => {});
  const started = Date.now();
  await adapter.start();
  // Disposal ends a pending discovery at once.
  await adapter.dispose();
  await assert.rejects(adapter.prompt("Task"), /unavailable/);
  assert(Date.now() - started < 3000, `${Date.now() - started} ms`);
});

test("Antigravity starts a session without waiting for a catalog agy never advertises", async (t) => {
  const requests = fixture(t);
  process.env.LOOP_TEST_AGY_MODE = "acp-hang";
  const events: AdapterEvent[] = [];
  const adapter = new Antigravity(options, (e) => events.push(e));
  try {
    const started = Date.now();
    await adapter.start();
    assert(Date.now() - started < 3000);
    // The first prompt waits for the bounded discovery, then stays literal.
    await adapter.prompt("/plan something");
    assert(Date.now() - started < 8000);
    await until(() => complete(events).length === 1);
    assert.deepEqual(adapter.commands, []);
    assert.deepEqual(
      requests()
        .filter((r) => r.event === "user")
        .map((r) => r.message.content),
      ["\u200b/plan something"],
    );
  } finally {
    await adapter.dispose();
  }
  const probe = new Antigravity({ ...options, probeOnly: true }, () => {});
  try {
    const started = Date.now();
    await probe.start();
    assert(Date.now() - started < 8000);
    assert.deepEqual(probe.commands, []);
  } finally {
    await probe.dispose();
  }
});

for (const mode of ["acp-failure", "acp-silent"]) {
  test(`Antigravity ${mode} starts with an empty catalog and keeps slash text literal`, async (t) => {
    const requests = fixture(t);
    process.env.LOOP_TEST_AGY_MODE = mode;
    const events: AdapterEvent[] = [];
    const adapter = new Antigravity(options, (e) => events.push(e));
    try {
      await adapter.start();
      assert.deepEqual(adapter.commands, []);
      await adapter.prompt("/plan something");
      await until(() => complete(events).length === 1);
      assert.deepEqual(
        requests()
          .filter((r) => r.event === "user")
          .map((r) => r.message.content),
        ["\u200b/plan something"],
      );
    } finally {
      await adapter.dispose();
    }
  });
}

for (const mode of ["WAITING", "RUNNING", "ERROR", "INVALID", "disconnect"]) {
  test(`Antigravity ${mode} preserves partial output without completing or replaying work`, async (t) => {
    const requests = fixture(t);
    process.env.LOOP_TEST_AGY_MODE = mode;
    const events: AdapterEvent[] = [];
    const adapter = new Antigravity(options, (e) => events.push(e));
    try {
      await adapter.start();
      await adapter.prompt("One task");
      await until(() =>
        events.some((e) => e.type === "status" && e.status === "failed"),
      );
      assert.equal(complete(events).length, 0);
      assert(events.some((e) => e.type === "delta"));
      assert.equal(requests().filter((r) => r.event === "user").length, 1);
      assert(!JSON.stringify(events).includes("private-credential-fixture"));
      assert(!events.some((e) => e.type === "status" && e.recoverable));
      await assert.rejects(
        adapter.prompt("follow-up on dead process"),
        /unavailable/,
      );
    } finally {
      await adapter.dispose();
    }
  });
}
test("Antigravity reports a soft-denied tool with an empty SUCCESS as a recoverable failure, not completion", async (t) => {
  const requests = fixture(t);
  process.env.LOOP_TEST_AGY_MODE = "soft-denied";
  const events: AdapterEvent[] = [];
  const adapter = new Antigravity(options, (e) => events.push(e));
  const failures = () =>
    events.filter((e) => e.type === "status" && e.status === "failed");
  try {
    await adapter.start();
    await adapter.prompt("List the projects");
    await until(() => failures().length === 1);
    assert.equal(complete(events).length, 0);
    assert(failures().every((e) => e.type === "status" && e.recoverable));
    assert(
      !events.some((e) => e.type === "item" && e.item.kind === "assistant"),
    );
    assert(!JSON.stringify(events).includes("private-credential-fixture"));
    assert(adapter.reusable);
    // The native conversation stays open; only an explicit follow-up is sent.
    await adapter.prompt("Explicit follow-up");
    await until(() => failures().length === 2);
    assert.equal(requests().filter((r) => r.event === "user").length, 2);
  } finally {
    await adapter.dispose();
  }
});

test("Antigravity ignores foreign results and cancellation stops the process without another prompt", async (t) => {
  const requests = fixture(t);
  process.env.LOOP_TEST_AGY_MODE = "foreign-result";
  const events: AdapterEvent[] = [];
  const adapter = new Antigravity(options, (e) => events.push(e));
  try {
    await adapter.start();
    await adapter.prompt("Task");
    await until(() => events.some((e) => e.type === "delta"));
    await adapter.cancel();
    assert.equal(complete(events).length, 0);
    assert(
      events.some((e) => e.type === "status" && e.status === "interrupted"),
    );
    assert(!JSON.stringify(events).includes("foreign private answer"));
    assert.equal(requests().filter((r) => r.event === "user").length, 1);
  } finally {
    await adapter.dispose();
  }
});
test("Antigravity rejects subscription billing, failed authentication and a mismatched resume without exposing diagnostics", async (t) => {
  fixture(t);
  await assert.rejects(
    new Antigravity({ ...options, billing: "subscription" }, () => {}).start(),
    /--billing existing/,
  );
  for (const mode of ["auth-failure", "wrong-resume"]) {
    process.env.LOOP_TEST_AGY_MODE = mode;
    const adapter = new Antigravity(
      { ...options, resume: "saved-session" },
      () => {},
    );
    try {
      await assert.rejects(adapter.start(), (error) => {
        assert.match((error as Error).message, /run agy/);
        assert.doesNotMatch(
          (error as Error).message,
          /private-credential-fixture/,
        );
        return true;
      });
    } finally {
      await adapter.dispose();
    }
  }
});

test("Antigravity ACP uses session-scoped MCP mode and standard model/effort settings", async (t) => {
  const requests = fixture(t);
  const events: AdapterEvent[] = [];
  const adapter = new Antigravity(
    {
      ...options,
      version: "1.5.9",
      model: "gemini-agy-fixture",
      effort: "high",
      instructions: "Saved instructions",
    },
    (event) => events.push(event),
  );
  try {
    await adapter.start();
    assert.equal(adapter.capabilities.workspaceTools, true);
    assert.equal(adapter.capabilities.approvals, true);
    assert.equal(adapter.activityTransport, "acp");
    assert.deepEqual(requests().find((r) => r.args?.[0] === "acp").args, [
      "acp",
      "--process-per-session",
    ]);
    assert.deepEqual(
      requests()
        .filter((r) => r.method === "session/set_config_option")
        .map((r) => [r.params.configId, r.params.value]),
      [
        ["model", "gemini-agy-fixture"],
        ["thinking_level", "high"],
      ],
    );
    await adapter.prompt("Explicit task");
    await until(() => complete(events).length === 1);
    assert.deepEqual(
      requests().find((r) => r.method === "session/prompt").params.prompt,
      [{ type: "text", text: "Saved instructions\n\nExplicit task" }],
    );
    await until(() => adapter.commands?.[0]?.name === "plan");
    await adapter.prompt("/plan this change");
    await until(() => complete(events).length === 2);
    assert.deepEqual(
      requests().findLast((r) => r.method === "session/prompt").params.prompt,
      [{ type: "text", text: "/plan this change\n\nSaved instructions" }],
    );
  } finally {
    await adapter.dispose();
  }
});

for (const mode of ["delayed-commands", "early-commands"]) {
  test(`Antigravity ACP handles ${mode} before its first slash command`, async (t) => {
    const requests = fixture(t);
    process.env.LOOP_TEST_AGY_MODE = mode;
    const events: AdapterEvent[] = [];
    const adapter = new Antigravity(
      { ...options, version: "1.5.9", instructions: "Saved instructions" },
      (event) => events.push(event),
    );
    try {
      await adapter.start();
      // The caller sends immediately, without waiting for command discovery.
      await adapter.prompt("/plan the first turn");
      await until(() => complete(events).length === 1);
      assert.deepEqual(
        requests().find((r) => r.method === "session/prompt").params.prompt,
        [{ type: "text", text: "/plan the first turn\n\nSaved instructions" }],
      );
    } finally {
      await adapter.dispose();
    }
  });
}

test("Antigravity ACP does not publish a ready session when requested effort is rejected", async (t) => {
  const requests = fixture(t);
  process.env.LOOP_TEST_AGY_MODE = "effort-rejected";
  const events: AdapterEvent[] = [];
  const adapter = new Antigravity(
    { ...options, version: "1.5.9", effort: "high" },
    (event) => events.push(event),
  );
  try {
    await assert.rejects(adapter.start(), /selected thinking level/);
    assert(
      !events.some(
        (event) => event.type === "status" && event.status === "ready",
      ),
    );
    assert(!events.some((event) => event.type === "metadata"));
    assert(!requests().some((request) => request.method === "session/prompt"));
  } finally {
    await adapter.dispose();
  }
});

for (const [mode, selection, code] of [
  ["unavailable-model", { model: "gone-model" }, "native_model_unavailable"],
  ["model-rejected", { model: "gemini-agy-fixture" }, "native_model_rejected"],
  [
    "unsupported-effort",
    { effort: "unavailable-effort" },
    "antigravity_effort_rejected",
  ],
  ["effort-rejected", { effort: "high" }, "antigravity_effort_rejected"],
  ["no-effort", { effort: "high" }, "antigravity_effort_unavailable"],
  ["effort-decoy", { effort: "high" }, "antigravity_effort_unavailable"],
] as const) {
  test(`Antigravity ACP reports safe configuration remediation for ${mode}`, async (t) => {
    const requests = fixture(t);
    process.env.LOOP_TEST_AGY_MODE = mode;
    const events: AdapterEvent[] = [];
    const adapter = new Antigravity(
      { ...options, version: "1.5.9", ...selection },
      (event) => events.push(event),
    );
    try {
      await assert.rejects(adapter.start(), (error) => {
        assert(error instanceof NativeSetupError);
        assert.equal(error.code, code);
        assert.match(error.message, /Choose|Select/);
        assert.doesNotMatch(
          error.message,
          /sign in|enable Antigravity again|private-/i,
        );
        return true;
      });
      assert(
        !events.some(
          (event) => event.type === "status" && event.status === "ready",
        ),
      );
      assert(
        !requests().some((request) => request.method === "session/prompt"),
      );
      if (mode === "effort-decoy")
        assert(
          !requests().some(
            (request) => request.method === "session/set_config_option",
          ),
        );
    } finally {
      await adapter.dispose();
    }
  });
}

for (const [kind, selection, configId] of [
  ["model", { model: "gemini-agy-fixture" }, "model"],
  ["effort", { effort: "high" }, "thinking_level"],
] as const) {
  test(
    `Antigravity ACP bounds startup ${kind} configuration when the agent stays connected`,
    { timeout: 24000 },
    async (t) => {
      const requests = fixture(t);
      process.env.LOOP_TEST_AGY_MODE = `hang-${kind}`;
      const events: AdapterEvent[] = [];
      const adapter = new Antigravity(
        { ...options, version: "1.5.9", ...selection },
        (event) => events.push(event),
      );
      t.after(() => adapter.dispose());
      await assert.rejects(adapter.start(), (error) => {
        assert(error instanceof NativeSetupError);
        assert.equal(error.code, "native_acp_configuration_timeout");
        assert.match(error.message, /did not confirm.*configuration/);
        assert.match(error.message, /Retry/);
        return true;
      });
      assert(
        requests().some(
          (request) =>
            request.event === "configuration-hung" &&
            request.configId === configId,
        ),
      );
      assert(
        !requests().some((request) => request.method === "session/prompt"),
      );
      assert(
        !events.some(
          (event) => event.type === "status" && event.status === "ready",
        ),
      );
    },
  );
}

test("Antigravity ACP treats a native model setting named acp-mode as configuration, not a permission-mode change", async (t) => {
  const requests = fixture(t);
  process.env.LOOP_TEST_AGY_MODE = "model-mode-id";
  const adapter = new Antigravity(
    { ...options, version: "1.5.9", model: "code" },
    () => {},
  );
  try {
    await adapter.start();
    assert.deepEqual(
      requests()
        .filter((request) => request.method === "session/set_config_option")
        .map((request) => [request.params.configId, request.params.value]),
      [["acp-mode", "code"]],
    );
    assert(
      !requests().some((request) => request.method === "session/set_mode"),
    );
  } finally {
    await adapter.dispose();
  }
});

test(
  "Antigravity ACP catalog probes bound missing discovery without publishing a ready session or prompting",
  { timeout: 12000 },
  async (t) => {
    const requests = fixture(t);
    process.env.LOOP_TEST_AGY_MODE = "no-commands";
    const events: AdapterEvent[] = [];
    const adapter = new Antigravity(
      { ...options, version: "1.5.9", probeOnly: true },
      (event) => events.push(event),
    );
    try {
      await adapter.start();
      assert.deepEqual(adapter.commands, []);
      assert(
        !events.some(
          (event) => event.type === "status" && event.status === "ready",
        ),
      );
      assert(!events.some((event) => event.type === "metadata"));
      assert(
        !requests().some((request) => request.method === "session/prompt"),
      );
    } finally {
      await adapter.dispose();
    }
  },
);

for (const mode of ["no-commands", "foreign-early-commands"]) {
  test(
    `Antigravity ACP keeps commands literal with ${mode}`,
    { timeout: 12000 },
    async (t) => {
      const requests = fixture(t);
      process.env.LOOP_TEST_AGY_MODE = mode;
      const events: AdapterEvent[] = [];
      const adapter = new Antigravity(
        { ...options, version: "1.5.9" },
        (event) => events.push(event),
      );
      try {
        await adapter.start();
        await adapter.prompt("/plan without a catalog");
        await until(() => complete(events).length === 1);
        assert.deepEqual(
          requests().find((r) => r.method === "session/prompt").params.prompt,
          [{ type: "text", text: "\u200b/plan without a catalog" }],
        );
      } finally {
        await adapter.dispose();
      }
    },
  );
}

for (const stop of ["cancel", "dispose"] as const) {
  test(`Antigravity ACP ${stop} prevents dispatch while waiting for commands`, async (t) => {
    const requests = fixture(t);
    process.env.LOOP_TEST_AGY_MODE = "no-commands";
    const adapter = new Antigravity({ ...options, version: "1.5.9" }, () => {});
    let dispatched = false;
    try {
      await adapter.start();
      const pending = assert.rejects(
        adapter.prompt("/plan must not dispatch", () => {
          dispatched = true;
        }),
        /unavailable/,
      );
      await adapter[stop]();
      await pending;
      assert.equal(dispatched, false);
      assert(!requests().some((r) => r.method === "session/prompt"));
    } finally {
      await adapter.dispose();
    }
  });
}

for (const [mode, model] of [
  ["many-models", "model-149"],
  ["late-model-setting", "gemini-agy-fixture"],
]) {
  test(`Antigravity ACP selects advertised models beyond display limits: ${mode}`, async (t) => {
    const requests = fixture(t);
    process.env.LOOP_TEST_AGY_MODE = mode;
    const events: AdapterEvent[] = [];
    const adapter = new Antigravity(
      { ...options, version: "1.5.9", model, effort: "high" },
      (event) => events.push(event),
    );
    try {
      await adapter.start();
      assert(adapter.models?.some((entry) => entry.id === model));
      assert(adapter.settings!.options.length <= 50);
      assert(
        adapter.settings!.options.every(
          (entry) => (entry.choices?.length ?? 0) <= 100,
        ),
      );
      await adapter.prompt("Use the selected model");
      await until(() => complete(events).length === 1);
      assert.deepEqual(
        requests()
          .filter((r) => r.method === "session/set_config_option")
          .map((r) => [r.params.configId, r.params.value]),
        [
          ["model", model],
          ["thinking_level", "high"],
        ],
      );
    } finally {
      await adapter.dispose();
    }
  });
}
