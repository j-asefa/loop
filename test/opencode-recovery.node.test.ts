import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "../src/adapters/opencode.js";
import { recordOwnedProcesses, identity } from "../src/process-records.js";
import { until } from "./helpers.js";
import {
  opencodeFixture,
  nativeMessage as message,
} from "./helpers/opencode-fixture.js";
const terminal = (events: any[], status: string) =>
  events.some((e) => e.type === "status" && e.status === status);
for (const outcome of ["completed", "failed", "interrupted"]) {
  test(`OpenCode recovers ${outcome} turn before settling, excluding prior run items`, async (t) => {
    const f = await opencodeFixture(t, [message("old")]);
    assert.equal(f.events.at(-1).status, "ready");
    await f.adapter.prompt("follow-up");
    await f.recover();
    const current = message(
      "new",
      outcome === "failed"
        ? { name: "APIError" }
        : outcome === "interrupted"
          ? { name: "MessageAbortedError" }
          : undefined,
    );
    await f.control({ history: [message("old"), current], status: {} });
    await f.idle();
    await until(() => terminal(f.events, outcome));
    assert.deepEqual(
      f.events.filter((e) => e.type === "item").map((e) => e.item.id),
      ["new-text", "new-tool"],
    );
    assert.equal(f.events.at(-1).status, outcome);
    const barrier = f.events.length;
    await f.control({
      events: [
        {
          type: "message.part.updated",
          properties: { part: message("old").parts[0] },
        },
        {
          type: "message.part.updated",
          properties: { part: current.parts[0] },
        },
        {
          type: "session.status",
          properties: { sessionID: "ses_1", status: { type: "busy" } },
        },
      ],
    });
    await until(() => terminal(f.events.slice(barrier), "running"));
    assert(!f.events.some((e) => e.item?.id === "old-text"));
    assert.equal(f.events.filter((e) => e.item?.id === "new-text").length, 1);
    await f.adapter.prompt("next");
    await f.recover();
    await f.control({
      history: [message("old"), current, message("next")],
      status: {},
    });
    await f.idle();
    await until(() => terminal(f.events, "completed"));
    assert.deepEqual(
      f.events.filter((e) => e.type === "item").map((e) => e.item.id),
      ["next-text", "next-tool"],
    );
    assert.equal(f.events.at(-1).status, "completed");
  });
}
test("OpenCode recovery keeps busy turns running and refreshes final output before idle", async (t) => {
  const f = await opencodeFixture(t);
  await f.adapter.prompt("test");
  await f.recover();
  await f.control({
    history: [message("final")],
    status: {},
    events: [
      {
        type: "message.part.delta",
        properties: {
          sessionID: "ses_1",
          messageID: "final",
          partID: "final-text",
          field: "text",
          delta: "stale",
        },
      },
      {
        type: "session.status",
        properties: { sessionID: "ses_1", status: { type: "idle" } },
      },
    ],
  });
  await until(() => terminal(f.events, "completed"));
  assert.deepEqual(
    f.events.map((e) => e.type),
    ["item", "item", "status"],
  );
  assert.equal(f.events.at(-1).status, "completed");
});
for (const path of [
  "/permission",
  "/question",
  "/api/session/ses_1/permission",
  "/api/session/ses_1/question",
  "/session/status",
  "/session/ses_1/message?limit=100",
]) {
  test(`OpenCode retries final recovery after a transient ${path} failure`, async (t) => {
    const f = await opencodeFixture(t);
    await f.adapter.prompt("test");
    await f.recover();
    await f.control({
      history: [message("final")],
      status: {},
      failures: { [path]: 1 },
      resetCalls: true,
    });
    await f.idle();
    await until(() => terminal(f.events, "completed"));
    const { calls } = await f.control();
    assert.equal(calls.filter((p) => p === path).length, 2);
    assert.deepEqual(
      f.events.map((e) => e.type),
      ["error", "item", "item", "status"],
    );
    assert.equal(f.events.at(-1).status, "completed");
    await f.adapter.prompt("next");
    await f.recover();
    await f.control({ status: {} });
    await f.idle();
    await until(() => terminal(f.events, "completed"));
    assert.equal(f.events.at(-1).status, "completed");
  });
}
test("OpenCode fails the turn when final recovery retries are exhausted", async (t) => {
  const f = await opencodeFixture(t);
  await f.adapter.prompt("test");
  await f.recover();
  await f.control({ failures: { "/permission": 4 }, resetCalls: true });
  await f.idle();
  await until(() => terminal(f.events, "failed"));
  const { calls } = await f.control();
  assert.equal(calls.filter((p) => p === "/permission").length, 4);
  assert.equal(f.events.at(-1).recoverable, true);
  assert.equal(f.events.at(-1).status, "failed");
  await f.adapter.prompt("next");
  await f.recover();
  await f.control({ status: {}, history: [message("next")] });
  await f.idle();
  await until(() => terminal(f.events, "completed"));
  assert.equal(f.events.at(-1).status, "completed");
});
test("OpenCode disposal cancels pending final recovery retries", async (t) => {
  const f = await opencodeFixture(t);
  await f.adapter.prompt("test");
  await f.recover();
  await f.control({ failures: { "/permission": 4 }, resetCalls: true });
  await f.idle();
  await until(() => f.events.some((e) => e.type === "error"));
  const { calls } = await f.control();
  assert.equal(calls.filter((p) => p === "/permission").length, 1);
  const beforeDispose = f.events.length;
  await f.dispose();
  // The next retry would be due after 200 ms; no terminal event may escape disposal.
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert(!f.events.some((e) => e.type === "status"));
  assert.equal(f.events.length, beforeDispose);
  await assert.rejects(f.control(), /ENOENT/);
});
test("OpenCode's detached server is recorded for a forced loop stop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loop-opencode-"));
  const registry = join(dir, "children.json");
  recordOwnedProcesses(registry);
  const executable = join(dir, "server-exits");
  const observedPid = join(dir, "server-pid");
  await writeFile(
    executable,
    `#!${process.execPath}
require("node:fs").writeFileSync(${JSON.stringify(observedPid)}, String(process.pid));
process.exit(1);
`,
    { mode: 0o755 },
  );
  const adapter = new OpenCode(
    {
      harness: "opencode",
      executable,
      project: dir,
      version: "fixture",
      billing: "existing",
    },
    () => {},
  );
  try {
    const started = adapter.start();
    const [recorded] = JSON.parse(readFileSync(registry, "utf8"));
    assert.ok(
      recorded,
      "The spawned native server must have an ownership record",
    );
    assert.ok(recorded.pid > 0);
    assert.equal(recorded.identity, identity(recorded.pid));
    await assert.rejects(started, /exited during startup/);
    assert.equal(recorded.pid, Number(readFileSync(observedPid, "utf8")));
    assert.deepEqual(JSON.parse(readFileSync(registry, "utf8")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
