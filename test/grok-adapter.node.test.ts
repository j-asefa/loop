import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Grok } from "../src/adapters/grok.js";
import type { AdapterEvent } from "../src/protocol.js";
import type { Options } from "../src/adapters/types.js";
import { until } from "./helpers.js";

const options: Options = {
  harness: "grok",
  executable: resolve("test/fixtures/fake-grok.mjs"),
  project: process.cwd(),
  billing: "existing",
  version: "1.0.70",
};
const requests = () =>
  readFileSync(process.env.LOOP_TEST_GROK_LOG!, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
function log(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "loop-grok-"));
  process.env.LOOP_TEST_GROK_LOG = join(dir, "requests");
  t.after(() => {
    delete process.env.LOOP_TEST_GROK_LOG;
    rmSync(dir, { recursive: true, force: true });
  });
}

test("Grok verifies sign-in and discovers native models without a prompt or authentication call", async (t) => {
  log(t);
  const events: AdapterEvent[] = [];
  const adapter = new Grok({ ...options, probeOnly: true }, (event) =>
    events.push(event),
  );
  try {
    assert.equal((await adapter.start()).mode, "existing");
    assert(adapter.models.some((model) => model.id === "grok-fixture"));
    assert.deepEqual(
      requests().map((req) => req.method),
      ["initialize", "session/new"],
    );
    assert(
      !events.some(
        (event) => event.type === "metadata" || event.type === "error",
      ),
    );
  } finally {
    await adapter.dispose();
  }
});

test("Grok carries the selected model, private tool bridge and instructions once per session, relays approvals, and resumes native context", async (t) => {
  log(t);
  const events: AdapterEvent[] = [];
  const adapter = new Grok(
    {
      ...options,
      model: "grok-fixture",
      instructions: "Project instructions",
      workspaceTools: {
        url: "http://127.0.0.1:1234/mcp",
        token: "private-fixture",
      },
    },
    (event) => events.push(event),
  );
  try {
    await adapter.start();
    await adapter.prompt("hello");
    await until(() => events.some((event) => event.type === "request"));
    const permission = events.find((event) => event.type === "request");
    assert(permission?.type === "request");
    await adapter.answer(permission.request.id, { choice: "allow" });
    await until(() =>
      events.some(
        (event) => event.type === "status" && event.status === "completed",
      ),
    );
    assert(
      events.some(
        (event) => event.type === "delta" && event.text === "Grok fixture answer",
      ),
    );
    const sent = requests();
    assert.equal(
      sent.find((req) => req.method === "session/set_model").params.modelId,
      "grok-fixture",
    );
    assert.equal(
      sent.find((req) => req.method === "session/new").params.mcpServers[0]
        .headers[0].value,
      "Bearer private-fixture",
    );
    assert.equal(
      sent.find((req) => req.method === "session/prompt").params.prompt[0].text,
      "Project instructions\n\nhello",
    );
    assert(!JSON.stringify(events).includes("private-fixture"));
    // Grok keeps the instructions in the session; later prompts omit them.
    const completed = () =>
      events.filter(
        (event) => event.type === "status" && event.status === "completed",
      ).length;
    await adapter.prompt("again");
    await until(
      () => events.filter((event) => event.type === "request").length === 2,
    );
    const second = events.filter((event) => event.type === "request")[1];
    assert(second.type === "request");
    await adapter.answer(second.request.id, { choice: "allow" });
    await until(() => completed() === 2);
  } finally {
    await adapter.dispose();
  }
  const replay: AdapterEvent[] = [];
  const resumed = new Grok(
    { ...options, resume: "grok-session", instructions: "Project instructions" },
    (event) => replay.push(event),
  );
  try {
    await resumed.start();
    // session/load replays history; Loop already has its own display.
    assert(!replay.some((event) => event.type === "delta"));
    await resumed.prompt("continue");
    await until(() => replay.some((event) => event.type === "request"));
    await resumed.cancel();
    await until(() =>
      replay.some(
        (event) => event.type === "status" && event.status === "interrupted",
      ),
    );
    assert.deepEqual(
      requests()
        .filter((req) => req.method === "session/prompt")
        .map((req) => req.params.prompt[0].text),
      // The load replayed turns, so the session already has its instructions.
      ["Project instructions\n\nhello", "again", "continue"],
    );
  } finally {
    await resumed.dispose();
  }
  // A load that replays nothing proves no earlier prompt reached the session.
  process.env.LOOP_TEST_GROK_EMPTY_LOAD = "1";
  const empty = new Grok(
    { ...options, resume: "grok-session", instructions: "Project instructions" },
    () => {},
  );
  try {
    await empty.start();
    await empty.prompt("fresh");
    await until(() =>
      requests().some(
        (req) =>
          req.method === "session/prompt" &&
          req.params.prompt[0].text.endsWith("fresh"),
      ),
    );
    assert.equal(
      requests().filter((req) => req.method === "session/prompt").at(-1).params
        .prompt[0].text,
      "Project instructions\n\nfresh",
    );
  } finally {
    delete process.env.LOOP_TEST_GROK_EMPTY_LOAD;
    await empty.dispose();
  }
});

test("Grok resends instructions after a first turn that did not complete", async (t) => {
  log(t);
  process.env.LOOP_TEST_GROK_REJECT_PROMPT = "1";
  const events: AdapterEvent[] = [];
  const adapter = new Grok(
    { ...options, instructions: "Project instructions" },
    (event) => events.push(event),
  );
  try {
    await adapter.start();
    await adapter.prompt("first");
    await until(() =>
      events.some((event) => event.type === "status" && event.status === "failed"),
    );
    await adapter.prompt("retry");
    await until(() => events.some((event) => event.type === "request"));
    assert.deepEqual(
      requests()
        .filter((req) => req.method === "session/prompt")
        .map((req) => req.params.prompt[0].text),
      ["Project instructions\n\nfirst", "Project instructions\n\nretry"],
    );
  } finally {
    delete process.env.LOOP_TEST_GROK_REJECT_PROMPT;
    await adapter.dispose();
  }
});

test("Grok rejects unverifiable subscription policy and redacts a signed-out account check", async (t) => {
  log(t);
  const subscription = new Grok(
    { ...options, billing: "subscription" },
    () => {},
  );
  await assert.rejects(subscription.start(), /--billing existing/);
  process.env.LOOP_TEST_GROK_SIGNED_OUT = "1";
  const adapter = new Grok({ ...options, probeOnly: true }, () => {});
  try {
    await assert.rejects(adapter.start(), (error: Error) => {
      assert.match(error.message, /Sign in to Grok Build in Provider connections/);
      assert.doesNotMatch(error.message, /private-credential/);
      return true;
    });
  } finally {
    delete process.env.LOOP_TEST_GROK_SIGNED_OUT;
    await adapter.dispose();
  }
});
