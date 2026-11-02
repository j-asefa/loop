import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Antigravity } from "../src/adapters/antigravity.js";
import type { AdapterEvent } from "../src/protocol.js";
import type { Options } from "../src/adapters/types.js";
import { until } from "./helpers.js";

const options: Options = {
  harness: "antigravity",
  executable: resolve("test/fixtures/fake-antigravity.mjs"),
  project: process.cwd(),
  billing: "existing",
  version: "1.4.9",
};
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "loop55-agy-"));
  const path = join(dir, "requests");
  process.env.LOOP55_TEST_AGY_LOG = path;
  t.after(() => {
    delete process.env.LOOP55_TEST_AGY_LOG;
    delete process.env.LOOP55_TEST_AGY_MODE;
    rmSync(dir, { recursive: true, force: true });
  });
  return () =>
    readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
}
const complete = (events: AdapterEvent[]) =>
  events.filter((e) => e.type === "status" && e.status === "completed");

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
    assert.equal(requests().length, 2);
    assert.deepEqual(requests()[0].args, ["models"]);
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
    const args = requests()[1].args;
    assert(args.includes("--disable-slash-commands"));
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
    const args = requests().at(-1).args;
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

for (const mode of ["WAITING", "RUNNING", "ERROR", "INVALID", "disconnect"]) {
  test(`Antigravity ${mode} preserves partial output without completing or replaying work`, async (t) => {
    const requests = fixture(t);
    process.env.LOOP55_TEST_AGY_MODE = mode;
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
  process.env.LOOP55_TEST_AGY_MODE = "soft-denied";
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
  process.env.LOOP55_TEST_AGY_MODE = "foreign-result";
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
    process.env.LOOP55_TEST_AGY_MODE = mode;
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
