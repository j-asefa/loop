import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Gemini } from "../src/adapters/gemini.js";
import type { AdapterEvent } from "../src/protocol.js";
import type { Options } from "../src/adapters/types.js";
import { until } from "./helpers.js";

const options: Options = {
  harness: "gemini",
  executable: resolve("test/fixtures/fake-gemini.mjs"),
  project: process.cwd(),
  billing: "existing",
  version: "0.64.0",
};
test("Gemini verifies sign-in and discovers native models without a prompt or authentication change", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "loop-gemini-"));
  process.env.LOOP_TEST_GEMINI_LOG = join(dir, "requests");
  t.after(() => {
    delete process.env.LOOP_TEST_GEMINI_LOG;
    rmSync(dir, { recursive: true, force: true });
  });
  const events: AdapterEvent[] = [];
  const adapter = new Gemini({ ...options, probeOnly: true }, (event) =>
    events.push(event),
  );
  try {
    assert.equal((await adapter.start()).mode, "existing");
    assert(adapter.models.some((model) => model.id === "gemini-fixture"));
    const requests = readFileSync(process.env.LOOP_TEST_GEMINI_LOG, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      requests.map((req) => req.method),
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

test("Gemini carries the selected model, private tool bridge and instructions, handles approvals, and resumes native context", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "loop-gemini-turn-"));
  process.env.LOOP_TEST_GEMINI_LOG = join(dir, "requests");
  t.after(() => {
    delete process.env.LOOP_TEST_GEMINI_LOG;
    rmSync(dir, { recursive: true, force: true });
  });
  const events: AdapterEvent[] = [];
  const adapter = new Gemini(
    {
      ...options,
      model: "gemini-fixture",
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
    await adapter.answer(permission.request.id, { choice: "yes" });
    await until(() =>
      events.some(
        (event) => event.type === "status" && event.status === "completed",
      ),
    );
    assert(
      events.some(
        (event) =>
          event.type === "delta" && event.text === "Gemini fixture answer",
      ),
    );
    const requests = readFileSync(process.env.LOOP_TEST_GEMINI_LOG, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      requests.find((req) => req.method === "session/set_model").params.modelId,
      "gemini-fixture",
    );
    assert.equal(
      requests.find((req) => req.method === "session/new").params.mcpServers[0]
        .headers[0].value,
      "Bearer private-fixture",
    );
    assert.equal(
      requests.find((req) => req.method === "session/prompt").params.prompt[0]
        .text,
      "Project instructions\n\nhello",
    );
    assert(!JSON.stringify(events).includes("private-fixture"));
  } finally {
    await adapter.dispose();
  }
  const replay: AdapterEvent[] = [];
  const resumed = new Gemini(
    {
      ...options,
      resume: "gemini-session",
      instructions: "Project instructions",
    },
    (event) => replay.push(event),
  );
  try {
    await resumed.start();
    assert(!replay.some((event) => event.type === "delta"));
    await resumed.prompt("continue");
    await until(() => replay.some((event) => event.type === "request"));
    await resumed.cancel();
    await until(() =>
      replay.some(
        (event) => event.type === "status" && event.status === "interrupted",
      ),
    );
    const prompts = readFileSync(process.env.LOOP_TEST_GEMINI_LOG, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((request) => request.method === "session/prompt");
    assert.deepEqual(
      prompts.map((request) => request.params.prompt[0].text),
      ["Project instructions\n\nhello", "Project instructions\n\ncontinue"],
    );
  } finally {
    await resumed.dispose();
  }
});

test("Gemini rejects unverifiable subscription policy and redacts failed account verification", async () => {
  const subscription = new Gemini(
    { ...options, billing: "subscription" },
    () => {},
  );
  await assert.rejects(subscription.start(), /--billing existing/);
  process.env.LOOP_TEST_GEMINI_FAIL = "1";
  const adapter = new Gemini({ ...options, probeOnly: true }, () => {});
  try {
    await assert.rejects(adapter.start(), /Sign in to Gemini CLI in Provider connections/);
  } finally {
    delete process.env.LOOP_TEST_GEMINI_FAIL;
    await adapter.dispose();
  }
});
