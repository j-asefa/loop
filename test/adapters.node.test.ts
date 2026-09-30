process.env.LOOP_PROFILE = "companion";
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { resolve } from "node:path";
import { Codex } from "../src/adapters/codex.js";
import { Pi } from "../src/adapters/pi.js";
import { NativeSetupError } from "../src/adapters/setup-error.js";
import { Claude } from "../src/adapters/claude.js";
import { OpenCode } from "../src/adapters/opencode.js";
import { conflict } from "../src/adapters/types.js";
import type { AdapterEvent, Harness } from "../src/protocol.js";
const executable = resolve("test/harness.mjs");
chmodSync(executable, 0o755);
import { until } from "./helpers.js";
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
    }
  });
}
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
