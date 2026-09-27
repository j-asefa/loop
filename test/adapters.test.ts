process.env.LOOP_PROFILE = "companion";
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { resolve } from "node:path";
import { Codex } from "../src/adapters/codex.js";
import { Pi } from "../src/adapters/pi.js";
import { Claude } from "../src/adapters/claude.js";
import { OpenCode } from "../src/adapters/opencode.js";
import { conflict } from "../src/adapters/types.js";
import type { AdapterEvent, Harness } from "../src/protocol.js";
const executable = resolve("test/harness.mjs");
chmodSync(executable, 0o755);
import { until } from "./helpers.js";
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
