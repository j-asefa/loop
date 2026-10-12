process.env.LOOP_PROFILE = "companion";
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Codex } from "../src/adapters/codex.js";
import { Pi } from "../src/adapters/pi.js";
import { NativeSetupError } from "../src/adapters/setup-error.js";
import { NotDelivered } from "../src/adapters/types.js";
import { Claude } from "../src/adapters/claude.js";
import { OpenCode } from "../src/adapters/opencode.js";
import { conflict } from "../src/adapters/types.js";
import type { AdapterEvent, Harness } from "../src/protocol.js";
const executable = resolve("test/harness.mjs");
chmodSync(executable, 0o755);
import { until } from "./helpers.js";
import codexToolApproval from "./fixtures/codex-tool-approval.json" with { type: "json" };
import codexReviewApproval from "./fixtures/codex-review-approval.json" with { type: "json" };

test("Codex review approval without a tool title offers and delivers acceptance", async () => {
  const events: AdapterEvent[] = [];
  const adapter = new Codex(
    {
      harness: "codex",
      project: process.cwd(),
      executable,
      billing: "existing",
      version: "fixture",
    },
    (event) => events.push(event),
  );
  try {
    await adapter.start();
    await adapter.prompt("mcp-accept\n" + JSON.stringify(codexReviewApproval));
    await until(() => events.some((event) => event.type === "request"));
    const event = events.find((event) => event.type === "request")!;
    assert.equal(event.type, "request");
    assert.equal(event.request.title, "Allow tool call?");
    assert.deepEqual(event.request.choices, ["accept", "decline", "cancel"]);
    assert.equal(event.request.allow, "accept");
    assert.equal(
      JSON.parse(event.request.detail).message,
      codexReviewApproval.message,
    );
    await adapter.answer(event.request.id, { choice: "accept" });
    // The subprocess fixture validates the exact one-call response, including
    // empty form content and no persisted session/always approval.
    await until(() =>
      events.some(
        (event) => event.type === "status" && event.status === "completed",
      ),
    );
    await assert.rejects(
      adapter.answer(event.request.id, { choice: "accept" }),
      /expired/,
    );
  } finally {
    await adapter.dispose();
  }
});

test("Codex MCP confirmations support one-call acceptance, decline and cancel", async () => {
  process.env.LOOP_TEST_HARNESS = "codex";
  const events: AdapterEvent[] = [];
  const adapter = new Codex(
    {
      harness: "codex",
      project: process.cwd(),
      executable,
      billing: "existing",
      version: "fixture",
    },
    (e) => events.push(e),
  );
  try {
    await adapter.start();
    for (const choice of ["accept", "decline", "cancel"]) {
      events.length = 0;
      await adapter.prompt(
        "mcp-" + choice + "\n" + JSON.stringify(codexToolApproval),
      );
      await until(() => events.some((e) => e.type === "request"));
      const event = events.find((e) => e.type === "request")!;
      assert.equal(event.type, "request");
      assert.equal(event.request.title, "Allow loop_delegate?");
      assert.deepEqual(event.request.choices, ["accept", "decline", "cancel"]);
      assert.equal(event.request.allow, "accept");
      await adapter.answer(event.request.id, { choice });
      await until(() =>
        events.some((e) => e.type === "status" && e.status === "completed"),
      );
      await assert.rejects(
        adapter.answer(event.request.id, { choice }),
        /expired/,
      );
    }
    for (const params of [
      { ...codexToolApproval, _meta: {} },
      {
        ...codexToolApproval,
        mode: "url",
        url: "https://example.com",
        elicitationId: "url",
      },
      {
        ...codexToolApproval,
        requestedSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
      {
        ...codexToolApproval,
        requestedSchema: { type: "object", properties: {}, required: ["name"] },
      },
      {
        ...codexToolApproval,
        requestedSchema: {
          type: "object",
          properties: {},
          allOf: [{ required: ["name"] }],
        },
      },
      { ...codexToolApproval, requestedSchema: null },
    ]) {
      events.length = 0;
      await adapter.prompt("mcp-cancel\n" + JSON.stringify(params));
      await until(() => events.some((e) => e.type === "request"));
      const event = events.find((e) => e.type === "request")!;
      assert.equal(event.type, "request");
      assert.equal(event.request.allow, undefined);
      assert.deepEqual(event.request.choices, ["decline", "cancel"]);
      await assert.rejects(
        adapter.answer(event.request.id, { choice: "accept" }),
        /Unsupported/,
      );
      await adapter.answer(event.request.id, { choice: "cancel" });
      await until(() =>
        events.some((e) => e.type === "status" && e.status === "completed"),
      );
    }
  } finally {
    await adapter.dispose();
    delete process.env.LOOP_TEST_HARNESS;
  }
});
test("Codex async questions surface once and accept answers during or after native work", async () => {
  process.env.LOOP_TEST_HARNESS = "codex";
  process.env.LOOP_TEST_ASYNC_ANSWER = "1";
  try {
    for (const finished of [false, true]) {
      const events: AdapterEvent[] = [];
      const adapter = new Codex({
        harness: "codex", project: process.cwd(), executable,
        billing: "existing", version: "fixture",
      }, (event) => events.push(event));
      try {
        await adapter.start();
        await adapter.prompt(finished ? "async-question-finish" : "async-question");
        await until(() => events.some((e) => e.type === "request") &&
          (!finished || events.some((e) => e.type === "status" && e.status === "awaiting-input")));
        const requests = events.filter((e) => e.type === "request");
        assert.equal(requests.length, 1);
        const request = requests[0].request;
        assert.equal(request.kind, "question");
        assert.equal(request.allow, undefined);
        assert.deepEqual(request.questions, [{
          id: "0", title: "Restart now or wait?", options: ["Wait for active agents", "Restart now"],
        }]);
        assert(!events.some((e) => e.type === "status" && e.status === "completed"));
        await adapter.answer(request.id, { "0": ["Wait for active agents"] });
        await until(() => events.some((e) => e.type === "status" && e.status === "completed"));
        assert.equal(events.filter((e) => e.type === "resolved" && e.id === request.id).length, 1);
        await assert.rejects(adapter.answer(request.id, { "0": ["Restart now"] }), /expired/);
      } finally {
        await adapter.dispose();
      }
    }
  } finally {
    delete process.env.LOOP_TEST_HARNESS;
    delete process.env.LOOP_TEST_ASYNC_ANSWER;
  }
});

test("Codex can cancel while waiting for an async answer after native completion", async () => {
  process.env.LOOP_TEST_HARNESS = "codex";
  const events: AdapterEvent[] = [];
  const adapter = new Codex({
    harness: "codex", project: process.cwd(), executable,
    billing: "existing", version: "fixture",
  }, (event) => events.push(event));
  try {
    await adapter.start();
    await adapter.prompt("async-question-finish");
    await until(() => events.some((e) => e.type === "status" && e.status === "awaiting-input"));
    await adapter.cancel();
    assert(events.some((e) => e.type === "resolved"));
    assert(events.some((e) => e.type === "status" && e.status === "interrupted"));
    assert(!events.some((e) => e.type === "status" && e.status === "completed"));
  } finally {
    await adapter.dispose();
    delete process.env.LOOP_TEST_HARNESS;
  }
});

test("Codex does not reopen async questions from resumed history", async () => {
  process.env.LOOP_TEST_HARNESS = "codex";
  process.env.LOOP_TEST_ASYNC_HISTORY = "1";
  const events: AdapterEvent[] = [];
  const adapter = new Codex({
    harness: "codex", project: process.cwd(), executable, resume: "saved-thread",
    billing: "existing", version: "fixture",
  }, (event) => events.push(event));
  try {
    await adapter.start();
    assert(events.some((e) => e.type === "item" && e.item.id === "old-question"));
    assert(!events.some((e) => e.type === "request"));
  } finally {
    await adapter.dispose();
    delete process.env.LOOP_TEST_HARNESS;
    delete process.env.LOOP_TEST_ASYNC_HISTORY;
  }
});

test("Codex resumes history larger than the ordinary native frame limit", async () => {
  process.env.LOOP_TEST_HARNESS = "codex";
  process.env.LOOP_TEST_LARGE_CODEX_HISTORY = "1";
  const events: AdapterEvent[] = [];
  const adapter = new Codex({
    harness: "codex", project: process.cwd(), executable, resume: "large-thread",
    billing: "existing", version: "fixture",
  }, (event) => events.push(event));
  try {
    await adapter.start();
    const history = events.find((e) => e.type === "item" && e.item.id === "large-history");
    assert(history?.type === "item");
    assert.equal(history.item.text?.length, 9 * 1024 * 1024);
    await adapter.prompt("Continue after the saved history");
    await until(() => events.some((e) => e.type === "status" && e.status === "completed"));
  } finally {
    await adapter.dispose();
    delete process.env.LOOP_TEST_HARNESS;
    delete process.env.LOOP_TEST_LARGE_CODEX_HISTORY;
  }
});

test("Pi's subscription catalog excludes API routes for the same model", async () => {
  process.env.LOOP_TEST_HARNESS = "pi";
  process.env.LOOP_TEST_PI_API_MODEL = "1";
  try {
    for (const billing of ["subscription", "existing"] as const) {
      const adapter = new Pi(
        {
          harness: "pi",
          project: process.cwd(),
          executable,
          billing,
          version: "fixture",
        },
        () => {},
      );
      try {
        await adapter.start();
        assert(
          adapter.models.some((model) => model.id === "openai-codex/fixture"),
        );
        assert.equal(
          adapter.models.some((model) => model.id === "openai/fixture"),
          billing === "existing",
        );
      } finally {
        await adapter.dispose();
      }
    }
    process.env.LOOP_TEST_PI_AUTH = "api";
    const adapter = new Pi(
      {
        harness: "pi",
        project: process.cwd(),
        executable,
        billing: "subscription",
        version: "fixture",
      },
      () => {},
    );
    try {
      await assert.rejects(
        adapter.start(),
        (error) =>
          error instanceof NativeSetupError &&
          error.code === "native_billing_mismatch",
      );
    } finally {
      await adapter.dispose();
    }
  } finally {
    delete process.env.LOOP_TEST_HARNESS;
    delete process.env.LOOP_TEST_PI_API_MODEL;
    delete process.env.LOOP_TEST_PI_AUTH;
  }
});
test("Pi exposes model-specific effort and applies saved effort to new and resumed sessions", async () => {
  process.env.LOOP_TEST_HARNESS = "pi";
  try {
    for (const resume of [undefined, "pi-1"]) {
      const adapter = new Pi(
        {
          harness: "pi",
          project: process.cwd(),
          executable,
          billing: "existing",
          version: "fixture",
          effort: "high",
          resume,
        },
        () => {},
      );
      try {
        await adapter.start();
        assert.deepEqual(
          adapter.models.map((model) => [
            model.id,
            model.effortLevels?.map((level) => level.value),
          ]),
          [
            ["openai-codex/fixture", ["off", "low", "medium", "high"]],
            ["openai-codex/plain", ["off"]],
          ],
        );
        assert.equal(adapter.defaultModelOption?.defaultEffort, "medium");
        assert.equal(
          adapter.defaultModelOption?.resolvedModel,
          "openai-codex/fixture",
        );
        assert.equal(
          adapter.settings.options.find((option) => option.id === "effort")
            ?.confirmed,
          "high",
        );
      } finally {
        await adapter.dispose();
      }
    }
    const invalid = new Pi(
      {
        harness: "pi",
        project: process.cwd(),
        executable,
        billing: "existing",
        version: "fixture",
        effort: "ultra",
      },
      () => {},
    );
    try {
      await assert.rejects(invalid.start(), /thinking level supported/);
    } finally {
      await invalid.dispose();
    }
  } finally {
    delete process.env.LOOP_TEST_HARNESS;
  }
});
for (const [name, Klass] of Object.entries({
  codex: Codex,
  pi: Pi,
  claude: Claude,
  opencode: OpenCode,
})) {
  test(`${name}: real subprocess framing, incremental output, permissions, follow-up and cancellation`, async () => {
    process.env.LOOP_TEST_HARNESS = name;
    if (name === "claude") process.env.LOOP_TEST_CLAUDE_INJECTED_RESULTS = "1";
    const events: AdapterEvent[] = [];
    const adapter = new Klass(
      {
        harness: name as Harness,
        project: process.cwd(),
        executable,
        billing: "existing",
        version: "fixture",
      },
      (e) => events.push(e),
    );
    try {
      await adapter.start();
      await adapter.prompt("approve");
      await until(() => events.some((e) => e.type === "request"));
      assert(events.some((e) => e.type === "delta"));
      assert(events.some((e) => e.type === "item" && e.item.kind === "tool"));
      assert(
        !events.some((e) => e.type === "status" && e.status === "completed"),
      );
      const request = events.find((e) => e.type === "request")!;
      assert.equal(request.type, "request");
      // "Never ask" answers only the choice that permits this one call.
      assert.equal(
        request.request.allow,
        { codex: "accept", claude: "allow", opencode: "once" }[name],
      );
      await adapter.answer(request.request.id, {
        choice:
          name === "pi"
            ? "cancel"
            : name === "codex"
              ? "decline"
              : name === "opencode"
                ? "reject"
                : "deny",
      });
      await until(() =>
        events.some((e) => e.type === "status" && e.status === "completed"),
      );
      if (name === "codex" || name === "claude") {
        assert.deepEqual(events.filter(e => e.type === "usage").at(-1), {
          type: "usage", usage: { input_tokens: 120, output_tokens: 30 },
        });
      }
      assert(
        events.some(
          (e) =>
            e.type === "item" &&
            e.item.kind === "tool" &&
            ["completed", "declined", "failed"].includes(e.item.status ?? ""),
        ),
        "native tool has a final state",
      );
      await assert.rejects(
        () => adapter.answer(request.request.id, { choice: "allow" }),
        /expired/,
      );
      events.length = 0;
      await adapter.prompt("follow-up");
      await until(() =>
        events.some((e) => e.type === "status" && e.status === "completed"),
      );
      assert.equal(
        events.filter((e) => e.type === "metadata").length,
        0,
        "same native session",
      );
      events.length = 0;
      await adapter.prompt("wait");
      await until(() => events.some((e) => e.type === "delta"));
      await adapter.cancel();
      await until(() =>
        events.some((e) => e.type === "status" && e.status === "interrupted"),
      );
      if ("steer" in adapter) {
        events.length = 0;
        await adapter.prompt("wait");
        await until(() => events.some((e) => e.type === "delta"));
        await adapter.steer!("Focus on the tests");
        await until(() =>
          events.some((e) => e.type === "status" && e.status === "completed"),
        );
        assert(
          !events.some(
            (e) => e.type === "status" && e.status === "interrupted",
          ),
          "steering must not terminate the Loop run",
        );
      }
    } finally {
      await adapter.dispose();
      delete process.env.LOOP_TEST_HARNESS;
      delete process.env.LOOP_TEST_CLAUDE_INJECTED_RESULTS;
    }
  });
}
test("Claude launches in the workspace permission mode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-claude-argv-"));
  process.env.LOOP_TEST_HARNESS = "claude";
  process.env.LOOP_TEST_ARGV = join(dir, "argv");
  try {
    for (const permissionMode of [undefined, "default", "bypassPermissions"]) {
      const adapter = new Claude(
        {
          harness: "claude",
          project: process.cwd(),
          executable,
          billing: "existing",
          version: "fixture",
          permissionMode,
        },
        () => {},
      );
      try {
        await adapter.start();
        assert.equal(
          adapter.settings.options.find((option) => option.id === "mode")
            ?.confirmed,
          permissionMode,
        );
      } finally {
        await adapter.dispose();
      }
    }
    const launches = readFileSync(process.env.LOOP_TEST_ARGV, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(launches.length, 3);
    assert(!launches[0].includes("--permission-mode"));
    assert(!launches[1].includes("--permission-mode"));
    const flag = launches[2].indexOf("--permission-mode");
    assert.equal(launches[2][flag + 1], "bypassPermissions");
  } finally {
    delete process.env.LOOP_TEST_HARNESS;
    delete process.env.LOOP_TEST_ARGV;
    rmSync(dir, { recursive: true, force: true });
  }
});
test("subscription conflicts are rejected without changing the environment", () => {
  process.env.LOOP_TEST_CONFLICT = "not-a-real-key";
  assert.throws(
    () => conflict("subscription", ["LOOP_TEST_CONFLICT"]),
    /conflicts/,
  );
  assert.equal(process.env.LOOP_TEST_CONFLICT, "not-a-real-key");
  conflict("existing", ["LOOP_TEST_CONFLICT"]);
  delete process.env.LOOP_TEST_CONFLICT;
});

test("Pi steers only a live turn", async () => {
  process.env.LOOP_TEST_HARNESS = "pi";
  const events: AdapterEvent[] = [];
  const adapter = new Pi(
    {
      harness: "pi",
      project: process.cwd(),
      executable,
      billing: "existing",
      version: "fixture",
    },
    (e) => events.push(e),
  );
  try {
    await adapter.start();
    // Pi would queue this for its next prompt; Loop refuses it instead.
    await assert.rejects(() => adapter.steer("Too early"), /No active Pi turn/);
    await adapter.prompt("wait");
    await until(() => events.some((e) => e.type === "delta"));
    await adapter.steer("Focus on the tests");
    await until(() =>
      events.some((e) => e.type === "status" && e.status === "completed"),
    );
    await assert.rejects(() => adapter.steer("Too late"), /No active Pi turn/);
    // A steer Pi queues for its next prompt is taken back, not reported sent.
    events.length = 0;
    await adapter.prompt("wait");
    await until(() => events.some((e) => e.type === "delta"));
    await assert.rejects(
      () => adapter.steer("late"),
      (error) =>
        error instanceof NotDelivered && /before reading/.test(error.message),
    );
  } finally {
    await adapter.dispose();
    delete process.env.LOOP_TEST_HARNESS;
  }
});
test("Pi takes back a late steer only when it is the sole queued input", async () => {
  process.env.LOOP_TEST_HARNESS = "pi";
  const events: AdapterEvent[] = [];
  const adapter = new Pi(
    {
      harness: "pi",
      project: process.cwd(),
      executable,
      billing: "existing",
      version: "fixture",
    },
    (e) => events.push(e),
  );
  const queue = async () =>
    (await (adapter as any).native.request("fixture_queue", {}, false)).queue;
  const notDelivered = (error: unknown) => error instanceof NotDelivered;
  const unconfirmed = (error: unknown) =>
    !(error instanceof NotDelivered) && /confirm/.test(String(error));
  try {
    await adapter.start();
    await adapter.prompt("wait");
    await until(() => events.some((e) => e.type === "delta"));
    // Two steers at once are taken in turn, so neither clears the other.
    const results = await Promise.allSettled([
      adapter.steer("late-1"),
      adapter.steer("late-2"),
    ]);
    for (const result of results) {
      assert.equal(result.status, "rejected");
      assert.ok(notDelivered((result as PromiseRejectedResult).reason));
    }
    assert.deepEqual(await queue(), []);
    // Queued behind an extension's follow-up: nothing is cleared, and Loop
    // reports it unconfirmed rather than retryable.
    await assert.rejects(() => adapter.steer("late-behind"), unconfirmed);
    assert.deepEqual(await queue(), [
      ["followUp", "extension follow-up"],
      ["steering", "late-behind"],
    ]);
    await (adapter as any).native.request("clear_queue", {}, false);
    // Pi read it, but another follow-up is the one queued entry: clearing
    // removed someone else's input, so it is put back.
    await assert.rejects(() => adapter.steer("late-read"), unconfirmed);
    assert.deepEqual(await queue(), [["followUp", "extension follow-up"]]);
  } finally {
    await adapter.dispose();
    delete process.env.LOOP_TEST_HARNESS;
  }
});
test("Pi preserves assistant failures until settled and resets on follow-up", async () => {
  process.env.LOOP_TEST_HARNESS = "pi";
  const events: AdapterEvent[] = [];
  const adapter = new Pi(
    {
      harness: "pi",
      project: process.cwd(),
      executable,
      billing: "existing",
      version: "fixture",
    },
    (e) => events.push(e),
  );
  try {
    await adapter.start();
    await adapter.prompt("wait");
    await until(() => events.some((e) => e.type === "delta"));
    const message = (m: unknown) => (adapter as any).message(m);
    message({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        errorMessage: "Provider rate limit exceeded",
      },
    });
    message({ type: "agent_settled" });
    assert(
      events.some(
        (e) =>
          e.type === "error" && e.message === "Provider rate limit exceeded",
      ),
    );
    assert(events.some((e) => e.type === "status" && e.status === "failed"));
    assert(
      !events.some((e) => e.type === "status" && e.status === "completed"),
    );
    events.length = 0;
    await adapter.prompt("follow-up");
    await until(() =>
      events.some((e) => e.type === "status" && e.status === "completed"),
    );
    assert(!events.some((e) => e.type === "status" && e.status === "failed"));
  } finally {
    await adapter.dispose();
    delete process.env.LOOP_TEST_HARNESS;
  }
});

test("Claude subscription mode accepts native OAuth and rejects API or unverified providers before dispatch", async () => {
  const variables = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "LOOP_TEST_HARNESS",
    "LOOP_TEST_CLAUDE_AUTH",
    "LOOP_TEST_CLAUDE_PROVIDER",
    "LOOP_TEST_CLAUDE_KEY_SOURCE",
    "LOOP_TEST_CLAUDE_AUTH_KEY_SOURCE",
  ];
  const saved = new Map(variables.map((name) => [name, process.env[name]]));
  for (const name of variables) delete process.env[name];
  process.env.LOOP_TEST_HARNESS = "claude";
  try {
    for (const auth of ["oauth", "api", "none"]) {
      process.env.LOOP_TEST_CLAUDE_AUTH = auth;
      const adapter = new Claude(
        {
          harness: "claude",
          executable,
          project: process.cwd(),
          billing: "subscription",
          version: "fixture",
        },
        () => {},
      );
      try {
        if (auth === "oauth") {
          const billing = await adapter.start();
          assert.equal(billing.mode, "subscription");
          assert.equal(billing.provider, "firstParty");
        } else await assert.rejects(adapter.start(), /No API fallback/);
      } finally {
        await adapter.dispose();
      }
    }
    process.env.LOOP_TEST_CLAUDE_AUTH = "oauth";
    process.env.LOOP_TEST_CLAUDE_PROVIDER = "bedrock";
    const changed = new Claude(
      {
        harness: "claude",
        executable,
        project: process.cwd(),
        billing: "subscription",
        version: "fixture",
      },
      () => {},
    );
    try {
      await assert.rejects(
        changed.start(),
        /did not confirm the native subscription provider/,
      );
    } finally {
      await changed.dispose();
    }
    delete process.env.LOOP_TEST_CLAUDE_PROVIDER;
    process.env.LOOP_TEST_CLAUDE_KEY_SOURCE = "ANTHROPIC_API_KEY";
    const settingsKey = new Claude(
      {
        harness: "claude",
        executable,
        project: process.cwd(),
        billing: "subscription",
        version: "fixture",
      },
      () => {},
    );
    try {
      await assert.rejects(
        settingsKey.start(),
        (error) =>
          error instanceof NativeSetupError &&
          error.code === "claude_subscription_unverified",
      );
    } finally {
      await settingsKey.dispose();
    }
    const existingKey = new Claude(
      {
        harness: "claude",
        executable,
        project: process.cwd(),
        billing: "existing",
        version: "fixture",
      },
      () => {},
    );
    try {
      assert.match(
        (await existingKey.start()).description,
        /provider charges apply/,
      );
    } finally {
      await existingKey.dispose();
    }
    delete process.env.LOOP_TEST_CLAUDE_KEY_SOURCE;
    process.env.LOOP_TEST_CLAUDE_AUTH_KEY_SOURCE = "ANTHROPIC_API_KEY";
    const authKey = new Claude(
      {
        harness: "claude",
        executable,
        project: process.cwd(),
        billing: "subscription",
        version: "fixture",
      },
      () => {},
    );
    try {
      await assert.rejects(
        authKey.start(),
        (error) =>
          error instanceof NativeSetupError &&
          error.code === "claude_subscription_required",
      );
    } finally {
      await authKey.dispose();
    }
    delete process.env.LOOP_TEST_CLAUDE_AUTH_KEY_SOURCE;
    process.env.ANTHROPIC_API_KEY = "fixture-private-api-key";
    const conflict = new Claude(
      {
        harness: "claude",
        executable,
        project: process.cwd(),
        billing: "subscription",
        version: "fixture",
      },
      () => {},
    );
    try {
      await assert.rejects(conflict.start(), /ANTHROPIC_API_KEY/);
    } finally {
      await conflict.dispose();
    }
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
