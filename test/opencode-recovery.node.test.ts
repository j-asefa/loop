process.env.LOOP55_PROFILE = "companion";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "../src/adapters/opencode.js";
import { recordOwnedProcesses } from "../src/processes.js";
import { identity } from "../src/lifecycle.js";

function fixture() {
  const events: any[] = [];
  const adapter: any = new OpenCode(
    {
      harness: "opencode",
      executable: "unused",
      project: ".",
      version: "fixture",
      billing: "existing",
    },
    (e) => events.push(e),
  );
  adapter.session = "session";
  let messages: any[] = [];
  let status = {};
  adapter.api = async (path: string) =>
    path.includes("/message?")
      ? messages
      : path === "/session/status"
        ? status
        : [];
  const message = (id: string, error?: any) => ({
    info: { id, role: "assistant", error },
    parts: [
      {
        id: id + "-text",
        messageID: id,
        sessionID: "session",
        type: "text",
        text: id,
      },
      {
        id: id + "-tool",
        messageID: id,
        sessionID: "session",
        type: "tool",
        tool: "fixture",
        state: { status: "completed" },
      },
    ],
  });
  return {
    adapter,
    events,
    message,
    history: (value: any[]) => (messages = value),
    status: (value: any) => (status = value),
  };
}
for (const outcome of ["completed", "failed", "interrupted"]) {
  test(`OpenCode recovers ${outcome} turn before settling, excluding prior run items`, async () => {
    const f = fixture();
    f.history([f.message("old")]);
    await f.adapter.reconcile();
    assert.equal(f.events.at(-1).status, "ready");
    await f.adapter.prompt("follow-up");
    f.events.length = 0;
    f.adapter.reconcileOnly = true;
    f.history([
      f.message("old"),
      f.message(
        "new",
        outcome === "failed"
          ? { name: "APIError" }
          : outcome === "interrupted"
            ? { name: "MessageAbortedError" }
            : undefined,
      ),
    ]);
    await f.adapter.reconcile();
    assert.deepEqual(
      f.events.filter((e) => e.type === "item").map((e) => e.item.id),
      ["new-text", "new-tool"],
    );
    assert.equal(f.events.at(-1).status, outcome);
    assert.equal(f.adapter.activeTurn, false);
    // Delayed old SSE parts must not migrate ownership either.
    f.adapter.event({
      type: "message.part.updated",
      properties: { part: f.message("old").parts[0] },
    });
    assert(!f.events.some((e) => e.item?.id === "old-text"));
    f.adapter.event({
      type: "message.part.updated",
      properties: { part: f.message("new").parts[0] },
    });
    assert.equal(f.events.filter((e) => e.item?.id === "new-text").length, 1);
    // A second queued follow-up has a new boundary and settles normally.
    await f.adapter.prompt("next");
    f.events.length = 0;
    f.history([f.message("old"), f.message("new"), f.message("next")]);
    await f.adapter.reconcile();
    assert.deepEqual(
      f.events.filter((e) => e.type === "item").map((e) => e.item.id),
      ["next-text", "next-tool"],
    );
    assert.equal(f.events.at(-1).status, "completed");
  });
}
test("OpenCode recovery keeps busy turns running and refreshes final output before idle", async () => {
  const f = fixture();
  await f.adapter.reconcile();
  await f.adapter.prompt("test");
  f.adapter.reconcileOnly = true;
  f.status({ session: { type: "busy" } });
  await f.adapter.reconcile();
  assert.equal(f.events.at(-1).status, "running");
  assert.equal(f.adapter.activeTurn, true);
  f.adapter.scheduleHistory(); // An already scheduled refresh must retain the final flag.
  f.events.length = 0;
  f.history([f.message("final")]);
  f.status({});
  f.adapter.event({
    type: "session.status",
    properties: { sessionID: "session", status: { type: "idle" } },
  });
  assert.equal(f.events.length, 0);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(
    f.events.map((e) => e.type),
    ["item", "item", "status"],
  );
  assert.equal(f.events.at(-1).status, "completed");
  await f.adapter.dispose();
});

for (const path of [
  "/permission",
  "/question",
  "/api/session/session/permission",
  "/api/session/session/question",
  "/session/status",
  "/session/session/message?limit=100",
]) {
  test(`OpenCode retries final recovery after a transient ${path} failure`, async (t) => {
    const f = fixture();
    t.after(() => f.adapter.dispose());
    await f.adapter.reconcile();
    await f.adapter.prompt("test");
    f.adapter.reconcileOnly = true;
    f.history([f.message("final")]);
    const api = f.adapter.api;
    let calls = 0;
    f.adapter.api = async (requested: string) => {
      if (requested === path && ++calls === 1) throw new Error("temporary");
      return api(requested);
    };
    f.events.length = 0;
    f.adapter.event({
      type: "session.status",
      properties: { sessionID: "session", status: { type: "idle" } },
    });
    await waitForSettlement(f.adapter);
    assert.equal(calls, 2);
    assert.deepEqual(
      f.events.map((e) => e.type),
      ["error", "item", "item", "status"],
    );
    assert.equal(f.events.at(-1).status, "completed");
    // No second idle event was needed, and a queued follow-up can complete.
    await f.adapter.prompt("next");
    await f.adapter.reconcile();
    assert.equal(f.adapter.activeTurn, false);
  });
}

test("OpenCode fails the turn when final recovery retries are exhausted", async (t) => {
  const f = fixture();
  t.after(() => f.adapter.dispose());
  await f.adapter.reconcile();
  await f.adapter.prompt("test");
  f.adapter.reconcileOnly = true;
  let calls = 0;
  f.adapter.api = async () => {
    calls++;
    throw new Error("unavailable");
  };
  f.events.length = 0;
  f.adapter.scheduleHistory(true);
  await waitForSettlement(f.adapter);
  assert.equal(calls, 4);
  assert.equal(f.events.at(-1).status, "failed");
  assert.equal(f.events.at(-1).recoverable, true);
  assert.equal(f.adapter.refresh, undefined);
  assert.equal(f.adapter.finalRefresh, false);
});

test("OpenCode disposal cancels pending final recovery retries", async () => {
  const f = fixture();
  await f.adapter.prompt("test");
  let calls = 0;
  f.adapter.api = async () => {
    calls++;
    throw new Error("unavailable");
  };
  f.adapter.scheduleHistory(true);
  await new Promise((resolve) => setTimeout(resolve, 150));
  await f.adapter.dispose();
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(calls, 1);
  assert(!f.events.some((e) => e.type === "status"));
});

async function waitForSettlement(adapter: any) {
  const deadline = Date.now() + 5000;
  while (adapter.activeTurn && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(adapter.activeTurn, false, "turn must eventually settle");
}

test("OpenCode's detached server is recorded for a forced loop55 stop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loop55-opencode-"));
  const registry = join(dir, "children.json");
  recordOwnedProcesses(registry);
  // Node can't load a script named "serve", so this server exits at startup.
  const adapter: any = new OpenCode(
    {
      harness: "opencode",
      executable: process.execPath,
      project: dir,
      version: "fixture",
      billing: "existing",
    },
    () => {},
  );
  try {
    const started = adapter.start();
    const [recorded] = JSON.parse(readFileSync(registry, "utf8"));
    assert.equal(recorded.pid, adapter.child.pid);
    assert.equal(recorded.identity, identity(adapter.child.pid));
    await assert.rejects(started, /exited during startup/);
    assert.deepEqual(JSON.parse(readFileSync(registry, "utf8")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
