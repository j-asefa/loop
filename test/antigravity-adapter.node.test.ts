import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Antigravity } from "../src/adapters/antigravity.js";
import type { AdapterEvent } from "../src/adapters/events.js";
import { NotDelivered, type Options } from "../src/adapters/types.js";
import { until } from "./helpers.js";

const options: Options = {
  harness: "antigravity",
  executable: resolve("test/fixtures/fake-antigravity.mjs"),
  project: process.cwd(),
  billing: "existing",
  version: "1.5.9",
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
  return () =>
    existsSync(path)
      ? readFileSync(path, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
}
const prompts = (requests: () => any[]) =>
  requests()
    .filter((r) => r.acp === "session/prompt")
    .map((r) => r.params.prompt[0].text);
const statuses = (events: AdapterEvent[]) =>
  events.flatMap((e) => (e.type === "status" ? [e.status] : []));
const complete = (events: AdapterEvent[]) =>
  events.filter((e) => e.type === "status" && e.status === "completed");

test("Antigravity probes sign-in, models and the catalog over agy acp without a prompt or permission bypass", async (t) => {
  const requests = fixture(t);
  const adapter = new Antigravity({ ...options, probeOnly: true }, () => {});
  try {
    assert.equal((await adapter.start()).mode, "existing");
    assert.deepEqual(adapter.models, [
      { id: "native-default", name: "Use agent default" },
      { id: "gemini-agy-fixture", name: "Gemini fixture" },
      { id: "claude-agy-fixture", name: "Claude fixture" },
    ]);
    assert.deepEqual(
      adapter.commands.map((c) => c.token),
      ["/plan", "/antigravity-guide"],
    );
    assert.equal(adapter.capabilities.approvals, true);
    assert.deepEqual(
      requests()
        .filter((r) => r.args)
        .map((r) => r.args),
      [["models"], ["acp"]],
    );
    assert.deepEqual(
      requests()
        .filter((r) => r.acp)
        .map((r) => r.acp),
      ["initialize", "session/new"],
    );
    assert(!JSON.stringify(requests()).includes("authenticate"));
    assert(!JSON.stringify(requests()).includes("dangerously"));
  } finally {
    await adapter.dispose();
  }
});

test("Antigravity frames prompts, reports per-turn usage, applies effort and resumes only its saved conversation", async (t) => {
  const requests = fixture(t);
  const events: AdapterEvent[] = [];
  const adapter = new Antigravity(
    {
      ...options,
      model: "gemini-agy-fixture",
      effort: "high",
      instructions: "Saved instructions",
    },
    (e) => events.push(e),
  );
  try {
    await adapter.start();
    for (const text of [
      "First task",
      "/antigravity-guide explain skills",
      "/planner is not a command",
    ]) {
      const before = complete(events).length;
      await adapter.prompt(text);
      await until(() => complete(events).length === before + 1);
    }
    assert.deepEqual(prompts(requests), [
      "Saved instructions\n\nFirst task",
      "/antigravity-guide explain skills\n\nSaved instructions",
      "Saved instructions\n\n/planner is not a command",
    ]);
    assert.deepEqual(
      requests().find((r) => r.acp === "session/set_model").params.modelId,
      "gemini-agy-fixture",
    );
    assert.deepEqual(
      requests().find((r) => r.acp === "session/set_config_option").params,
      {
        sessionId: "agy-fixture-session",
        configId: "thought_level",
        value: "high",
      },
    );
    assert.deepEqual(
      events.flatMap((e) => (e.type === "usage" ? [e.usage] : [])),
      [
        { input_tokens: 13, output_tokens: 3 },
        { input_tokens: 13, output_tokens: 3 },
        { input_tokens: 13, output_tokens: 3 },
      ],
    );
    assert(!JSON.stringify(events).includes("private-"));
  } finally {
    await adapter.dispose();
  }
  const resumed = new Antigravity(
    { ...options, resume: "agy-saved-conversation" },
    () => {},
  );
  try {
    await resumed.start();
    const resume = requests().filter((r) => r.acp === "session/resume");
    assert.deepEqual(
      resume.map((r) => r.params.sessionId),
      ["agy-saved-conversation"],
    );
    // Resume never replays history or work.
    assert(!requests().some((r) => r.acp === "session/load"));
    assert.equal(prompts(requests).length, 3);
  } finally {
    await resumed.dispose();
  }
});

test("Antigravity steers a running turn with a concurrent prompt and completes the run once", async (t) => {
  const requests = fixture(t);
  const events: AdapterEvent[] = [];
  const adapter = new Antigravity(
    { ...options, instructions: "Saved instructions" },
    (e) => events.push(e),
  );
  try {
    await adapter.start();
    await adapter.prompt("[slow] Write an essay");
    await until(() => events.some((e) => e.type === "delta"));
    await adapter.steer("Change course");
    await until(() => complete(events).length === 1);
    assert.deepEqual(statuses(events), ["ready", "completed"]);
    // The steer is sent as written, without instructions or a restart.
    assert.deepEqual(prompts(requests), [
      "Saved instructions\n\n[slow] Write an essay",
      "Change course",
    ]);
    assert.equal(requests().filter((r) => r.args).length, 2);
    // The steered answer is a separate message from the partial one.
    const deltas = events.flatMap((e) => (e.type === "delta" ? [e] : []));
    assert.deepEqual(
      deltas.map((d) => d.text),
      ["Partial essay", "Steered answer"],
    );
    assert.notEqual(deltas[0].id, deltas[1].id);
    // Usage is cumulative across the turn's requests.
    assert.deepEqual(
      events.flatMap((e) => (e.type === "usage" ? [e.usage] : [])).at(-1),
      { input_tokens: 15, output_tokens: 3 },
    );
  } finally {
    await adapter.dispose();
  }
});

test("Antigravity confirms a steered skill by its echo without the command", async (t) => {
  const requests = fixture(t);
  const events: AdapterEvent[] = [];
  const adapter = new Antigravity(options, (e) => events.push(e));
  try {
    await adapter.start();
    await adapter.prompt("[slow] Long task");
    await until(() => events.some((e) => e.type === "delta"));
    await adapter.steer("/plan the rest");
    await until(() => complete(events).length === 1);
    assert.deepEqual(prompts(requests), ["[slow] Long task", "/plan the rest"]);
  } finally {
    await adapter.dispose();
  }
});

test("Antigravity steering refuses without a running turn, while an approval is open, or when the guard refuses", async (t) => {
  const requests = fixture(t);
  const events: AdapterEvent[] = [];
  const adapter = new Antigravity(options, (e) => events.push(e));
  try {
    await adapter.start();
    await assert.rejects(adapter.steer("No turn"), NotDelivered);
    await adapter.prompt("[approve] Needs approval");
    await until(() => events.some((e) => e.type === "request"));
    await assert.rejects(adapter.steer("During approval"), NotDelivered);
    const approval = events.find((e) => e.type === "request");
    assert(approval?.type === "request");
    await adapter.answer(approval.request.id, { choice: "allow" });
    await until(() => complete(events).length === 1);
    await adapter.prompt("[slow] Long task");
    await until(() =>
      events.some((e) => e.type === "delta" && e.text === "Partial essay"),
    );
    await assert.rejects(
      adapter.steer("Refused", () => {
        throw new NotDelivered("authorization revoked");
      }),
      /authorization revoked/,
    );
    assert.deepEqual(prompts(requests), [
      "[approve] Needs approval",
      "[slow] Long task",
    ]);
  } finally {
    await adapter.dispose();
  }
});

test("Antigravity keeps the turn running when agy rejects a steer, and does not confirm it", async (t) => {
  const requests = fixture(t);
  process.env.LOOP_TEST_AGY_MODE = "reject-steer";
  const events: AdapterEvent[] = [];
  const adapter = new Antigravity(options, (e) => events.push(e));
  try {
    await adapter.start();
    await adapter.prompt("[slow] Long task");
    await until(() => events.some((e) => e.type === "delta"));
    await assert.rejects(adapter.steer("Follow-up"), (error) => {
      assert(!(error instanceof NotDelivered));
      return true;
    });
    // The original turn is still the open one; nothing ended the run.
    assert.deepEqual(statuses(events), ["ready"]);
    await adapter.cancel();
    await until(() => statuses(events).includes("interrupted"));
    assert.equal(prompts(requests).length, 2);
  } finally {
    await adapter.dispose();
  }
});

test("Antigravity cancel during an unconfirmed steer ends both requests as interrupted", async (t) => {
  fixture(t);
  process.env.LOOP_TEST_AGY_MODE = "steer-no-echo";
  const events: AdapterEvent[] = [];
  const adapter = new Antigravity(options, (e) => events.push(e));
  try {
    await adapter.start();
    await adapter.prompt("[slow] Long task");
    await until(() => events.some((e) => e.type === "delta"));
    const steer = adapter.steer("Follow-up");
    await new Promise((r) => setTimeout(r, 100));
    await adapter.cancel();
    await assert.rejects(steer, /cancelled before steering was confirmed/);
    await until(() => statuses(events).includes("interrupted"));
    assert.deepEqual(statuses(events), ["ready", "interrupted"]);
  } finally {
    await adapter.dispose();
  }
});

test("Antigravity steering is unconfirmed when agy exits before taking it", async (t) => {
  fixture(t);
  process.env.LOOP_TEST_AGY_MODE = "steer-no-echo";
  const events: AdapterEvent[] = [];
  const adapter = new Antigravity(options, (e) => events.push(e));
  try {
    await adapter.start();
    await adapter.prompt("[slow] Long task");
    await until(() => events.some((e) => e.type === "delta"));
    const steer = adapter.steer("Follow-up");
    steer.catch(() => {});
    await new Promise((r) => setTimeout(r, 100));
    await adapter.dispose();
    await assert.rejects(steer, (error) => {
      assert(!(error instanceof NotDelivered));
      return true;
    });
  } finally {
    await adapter.dispose();
  }
});

for (const [mode, status] of [
  ["disconnect", "failed"],
  ["error", "failed"],
  ["cancelled", "interrupted"],
  ["max_tokens", "interrupted"],
] as const) {
  test(`Antigravity ${mode} preserves output without completing or replaying work`, async (t) => {
    const requests = fixture(t);
    process.env.LOOP_TEST_AGY_MODE = mode;
    const events: AdapterEvent[] = [];
    const adapter = new Antigravity(options, (e) => events.push(e));
    try {
      await adapter.start();
      await adapter.prompt("One task");
      await until(() => statuses(events).includes(status));
      assert.equal(complete(events).length, 0);
      assert(events.some((e) => e.type === "delta"));
      assert.equal(prompts(requests).length, 1);
      assert(!JSON.stringify(events).includes("private-credential-fixture"));
    } finally {
      await adapter.dispose();
    }
  });
}

test("Antigravity rejects subscription billing, failed sign-in and a missing conversation without exposing diagnostics", async (t) => {
  const requests = fixture(t);
  await assert.rejects(
    new Antigravity({ ...options, billing: "subscription" }, () => {}).start(),
    /--billing existing/,
  );
  for (const [mode, message] of [
    ["signed-out", /not signed in/],
    ["auth-failure", /run agy/],
    ["resume-missing", /run agy/],
  ] as const) {
    process.env.LOOP_TEST_AGY_MODE = mode;
    const adapter = new Antigravity(
      { ...options, resume: "saved-session" },
      () => {},
    );
    try {
      await assert.rejects(adapter.start(), (error) => {
        assert.match((error as Error).message, message);
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
  assert.equal(prompts(requests).length, 0);
});
