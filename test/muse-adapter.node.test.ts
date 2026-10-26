import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Muse, uuidv7 } from "../src/adapters/muse.js";
import { NotDelivered } from "../src/adapters/types.js";
import { NativeSetupError } from "../src/adapters/setup-error.js";
import type { AdapterEvent } from "../src/protocol.js";
import type { Options } from "../src/adapters/types.js";
import { until } from "./helpers.js";

const options: Options = {
  harness: "muse",
  executable: resolve("test/fixtures/fake-muse.mjs"),
  project: process.cwd(),
  billing: "existing",
  version: "1.4.12",
};
function fixture(t: { after(fn: () => void): void }, state?: string) {
  const dir = mkdtempSync(join(tmpdir(), "loop-muse-"));
  process.env.LOOP_TEST_MUSE_DIR = dir;
  process.env.LOOP_TEST_MUSE_LOG = join(dir, "requests");
  if (state)
    writeFileSync(join(dir, "muse-credential.json"), JSON.stringify({ state }));
  t.after(() => {
    delete process.env.LOOP_TEST_MUSE_DIR;
    delete process.env.LOOP_TEST_MUSE_LOG;
    rmSync(dir, { recursive: true, force: true });
  });
  return () =>
    readFileSync(join(dir, "requests"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
}

test("uuidv7 produces version 7 ids that MSP accepts", () => {
  const id = uuidv7();
  assert.match(
    id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert(
    Math.abs(parseInt(id.replace(/-/g, "").slice(0, 12), 16) - Date.now()) <
      5000,
  );
});

test("Muse checks its account and models without a session or prompt", async (t) => {
  const requests = fixture(t, "accountLogin");
  const events: AdapterEvent[] = [];
  const adapter = new Muse({ ...options, probeOnly: true }, (e) =>
    events.push(e),
  );
  try {
    const billing = await adapter.start();
    assert.equal(billing.mode, "existing");
    assert.match(billing.description, /Meta account/);
    assert.deepEqual(
      adapter.models.map((m) => [m.id, m.effortLevels?.map((e) => e.value)]),
      [
        ["muse-spark-fixture", ["low", "high"]],
        ["muse-other-fixture", ["high"]],
      ],
    );
    assert.deepEqual(
      requests().map((r) => r.method),
      ["initialize", "initialized", "account/read", "model/list"],
    );
    assert(requests().every((r) => r.jsonrpc === "2.0"));
    assert(!events.some((e) => e.type === "metadata"));
  } finally {
    await adapter.dispose();
  }
});

test("Muse refuses a signed-out account and subscription billing before any session", async (t) => {
  const requests = fixture(t);
  const signedOut = new Muse({ ...options, probeOnly: true }, () => {});
  try {
    await assert.rejects(signedOut.start(), /Muse Code is not signed in/);
  } finally {
    await signedOut.dispose();
  }
  const subscription = new Muse(
    { ...options, billing: "subscription" },
    () => {},
  );
  await assert.rejects(
    subscription.start(),
    /cannot verify subscription billing/,
  );
  assert(!requests().some((r) => r.method === "session/start"));
});

test("Muse streams a turn with instructions, workspace tools, model change and usage, then resumes", async (t) => {
  const requests = fixture(t, "apiKey");
  const events: AdapterEvent[] = [];
  const adapter = new Muse(
    {
      ...options,
      model: "muse-spark-fixture",
      instructions: "Project instructions",
      workspaceTools: {
        url: "http://127.0.0.1:1234/mcp",
        token: "private-fixture",
      },
    },
    (e) => events.push(e),
  );
  try {
    const billing = await adapter.start();
    assert.match(billing.description, /stored Meta API key/);
    const meta = events.find((e) => e.type === "metadata");
    assert(meta?.type === "metadata");
    await adapter.prompt("hello");
    await until(() =>
      events.some((e) => e.type === "status" && e.status === "completed"),
    );
    assert(
      events.some(
        (e) =>
          e.type === "delta" &&
          e.text === "muse-spark-fixture: Project instructions\n\nhello",
      ),
    );
    assert(
      events.some(
        (e) =>
          e.type === "item" &&
          e.item.kind === "assistant" &&
          e.item.phase === "final_answer",
      ),
    );
    assert(
      events.some(
        (e) =>
          e.type === "usage" &&
          e.usage.input_tokens === 7 &&
          e.usage.output_tokens === 3,
      ),
    );
    // Reasoning deltas are not reply text.
    assert(
      !events.some(
        (e) => e.type === "delta" && e.text.includes("private reasoning"),
      ),
    );
    // Tool activity is only native traces, so structured features are not claimed.
    for (const feature of ["tools", "output", "diffs", "plans"] as const)
      assert.equal(adapter.activityCapabilities[feature].state, "unsupported");
    const start = requests().find((r) => r.method === "session/start");
    assert.equal(start.params.workspaceRoot, process.cwd());
    assert.deepEqual(start.params.config.mcpServers.loop_workspace, {
      transport: "streamableHttp",
      mode: "optional",
      url: "http://127.0.0.1:1234/mcp",
      headers: { Authorization: "Bearer private-fixture" },
    });
    // A changed model applies to the next turn through session/setModel.
    const revision = adapter.settings.revision;
    await adapter.setSetting("model", "muse-other-fixture", revision);
    await adapter.prompt("again");
    await until(
      () =>
        events.filter((e) => e.type === "status" && e.status === "completed")
          .length === 2,
    );
    // The session already holds the instructions; later prompts omit them.
    assert(
      events.some(
        (e) => e.type === "delta" && e.text === "muse-other-fixture: again",
      ),
    );
    assert.equal(
      requests().filter((r) => r.method === "session/setModel")[0].params.model
        .modelId,
      "muse-other-fixture",
    );
    await adapter.dispose();
    const resumedEvents: AdapterEvent[] = [];
    const resumed = new Muse(
      {
        ...options,
        resume: meta.nativeSession,
        instructions: "Project instructions",
      },
      (e) => resumedEvents.push(e),
    );
    try {
      await resumed.start();
      const resume = requests().find((r) => r.method === "session/resume");
      assert.equal(resume.params.sessionId, meta.nativeSession);
      assert.equal(resume.params.excludeItems, true);
      // A resumed session with turns is not sent the instructions again.
      await resumed.prompt("after resume");
      await until(() =>
        resumedEvents.some(
          (e) => e.type === "status" && e.status === "completed",
        ),
      );
      assert(
        resumedEvents.some(
          (e) =>
            e.type === "delta" && e.text === "muse-spark-fixture: after resume",
        ),
      );
    } finally {
      await resumed.dispose();
    }
  } finally {
    await adapter.dispose();
  }
});

test("Muse offers only this-call approval choices and decides the current requirement", async (t) => {
  const requests = fixture(t, "accountLogin");
  const events: AdapterEvent[] = [];
  const adapter = new Muse(options, (e) => events.push(e));
  try {
    await adapter.start();
    await adapter.prompt("this needs approval");
    await until(() => events.some((e) => e.type === "request"));
    const request = events.find((e) => e.type === "request");
    assert(request?.type === "request");
    assert.deepEqual(request.request.choices, ["allow", "deny"]);
    assert.equal(request.request.allow, "allow");
    assert.match(request.request.title, /shell command/);
    await assert.rejects(
      adapter.answer(request.request.id, { choice: "c-session" }),
      /Unsupported/,
    );
    await adapter.answer(request.request.id, { choice: "allow" });
    await until(() =>
      events.some((e) => e.type === "status" && e.status === "completed"),
    );
    const decide = requests().find((r) => r.method === "approval/decide");
    assert.equal(decide.params.choiceId, "c-once");
    assert.deepEqual(decide.params.requirementId, {
      approvalId: "approval-1",
      sourceIndex: 0,
    });
    // The presentation request is answered with an empty receipt.
    assert(
      requests().some(
        (r) => r.id === "server-1" && JSON.stringify(r.result) === "{}",
      ),
    );
    assert(
      events.some((e) => e.type === "resolved" && e.id === request.request.id),
    );
  } finally {
    await adapter.dispose();
  }
});

test("Muse relays structured questions, steers and cancels a running turn", async (t) => {
  const requests = fixture(t, "accountLogin");
  const events: AdapterEvent[] = [];
  const adapter = new Muse(options, (e) => events.push(e));
  try {
    await adapter.start();
    await adapter.prompt("this needs input");
    await until(() => events.some((e) => e.type === "request"));
    const request = events.find((e) => e.type === "request");
    assert(request?.type === "request");
    assert.equal(request.request.kind, "question");
    assert.deepEqual(request.request.questions?.[0].options, ["Red", "Blue"]);
    await adapter.answer(request.request.id, { color: ["Blue"] });
    await until(() =>
      events.some((e) => e.type === "status" && e.status === "completed"),
    );
    assert.deepEqual(
      requests().find((r) => r.method === "userInput/answer").params.answers,
      [{ questionId: "color", selectedLabel: "Blue" }],
    );
    await adapter.prompt("this stays running");
    await until(
      () =>
        events.filter((e) => e.type === "status" && e.status === "running")
          .length === 2,
    );
    // A follow-up during the turn steers it, naming the turn it expects.
    await adapter.steer!("also check tests");
    await until(() =>
      events.some(
        (e) => e.type === "delta" && e.text === "steered: also check tests",
      ),
    );
    const steer = requests().find((r) => r.method === "turn/steer");
    assert.equal(
      steer.params.expectedTurnId,
      requests().filter((r) => r.method === "turn/start")[1].params.commandId,
    );
    await until(
      () =>
        events.filter((e) => e.type === "status" && e.status === "completed")
          .length === 2,
    );
    await assert.rejects(
      adapter.steer!("too late"),
      /No active Muse Code turn/,
    );
    await adapter.prompt("this stays running");
    await until(
      () =>
        events.filter((e) => e.type === "status" && e.status === "running")
          .length === 3,
    );
    await adapter.cancel();
    await until(() =>
      events.some((e) => e.type === "status" && e.status === "interrupted"),
    );
  } finally {
    await adapter.dispose();
  }
});

test("Muse answers a request for another session without presenting it", async (t) => {
  const requests = fixture(t, "accountLogin");
  const events: AdapterEvent[] = [];
  const adapter = new Muse(options, (e) => events.push(e));
  try {
    await adapter.start();
    await adapter.prompt("a foreign request arrives");
    await until(() => requests().some((r) => r.id === "foreign-1"));
    assert(requests().find((r) => r.id === "foreign-1").error);
    assert(!events.some((e) => e.type === "request"));
  } finally {
    await adapter.dispose();
  }
});

test("Muse stops a turn whose approval offers no this-call choice", async (t) => {
  const requests = fixture(t, "accountLogin");
  const events: AdapterEvent[] = [];
  const adapter = new Muse(options, (e) => events.push(e));
  try {
    await adapter.start();
    await adapter.prompt("this needs approval, session-only");
    await until(() =>
      events.some((e) => e.type === "status" && e.status === "interrupted"),
    );
    assert(!events.some((e) => e.type === "request"));
    assert(
      events.some(
        (e) => e.type === "error" && /grant in Muse itself/.test(e.message),
      ),
    );
    assert(requests().some((r) => r.method === "turn/interrupt"));
  } finally {
    await adapter.dispose();
  }
});

test("Muse presents each stage of a multi-stage approval as its own decision", async (t) => {
  const requests = fixture(t, "accountLogin");
  const events: AdapterEvent[] = [];
  const adapter = new Muse(options, (e) => events.push(e));
  try {
    await adapter.start();
    await adapter.prompt("this needs approval in two stages");
    await until(() => events.some((e) => e.type === "request"));
    const first = events.find((e) => e.type === "request");
    assert(first?.type === "request");
    await adapter.answer(first.request.id, { choice: "allow" });
    await until(() => events.filter((e) => e.type === "request").length === 2);
    const second = events.filter((e) => e.type === "request")[1];
    assert(second.type === "request");
    assert.notEqual(second.request.id, first.request.id);
    assert.match(second.request.detail, /ls \| wc -l/);
    await assert.rejects(
      adapter.answer(first.request.id, { choice: "allow" }),
      /Unsupported|expired/,
    );
    await adapter.answer(second.request.id, { choice: "allow" });
    await until(() =>
      events.some((e) => e.type === "status" && e.status === "completed"),
    );
    assert.deepEqual(
      requests()
        .filter((r) => r.method === "approval/decide")
        .map((r) => r.params.requirementId.sourceIndex),
      [0, 1],
    );
  } finally {
    await adapter.dispose();
  }
});

test("Muse does not revive a turn that finished before its start reply was handled", async (t) => {
  fixture(t, "accountLogin");
  const events: AdapterEvent[] = [];
  const adapter = new Muse(options, (e) => events.push(e));
  try {
    await adapter.start();
    await adapter.prompt("this finishes at once");
    assert(events.some((e) => e.type === "status" && e.status === "completed"));
    await assert.rejects(adapter.steer!("late"), /No active Muse Code turn/);
    await assert.rejects(adapter.cancel(), /No active Muse Code turn/);
  } finally {
    await adapter.dispose();
  }
});

test("Muse reports a refused steer as undelivered and maps missing sessions to setup guidance", async (t) => {
  fixture(t, "accountLogin");
  const events: AdapterEvent[] = [];
  const adapter = new Muse(options, (e) => events.push(e));
  try {
    await adapter.start();
    await adapter.prompt("this stays running");
    await until(() =>
      events.some((e) => e.type === "status" && e.status === "running"),
    );
    await assert.rejects(adapter.steer!("this is refused"), NotDelivered);
  } finally {
    await adapter.dispose();
  }
  const resumed = new Muse({ ...options, resume: "missing-session" }, () => {});
  try {
    await assert.rejects(
      resumed.start(),
      (error) =>
        error instanceof NativeSetupError &&
        error.code === "native_session_missing",
    );
  } finally {
    await resumed.dispose();
  }
});

test("Muse runs without workspace tools when the host withholds session MCP", async (t) => {
  const requests = fixture(t, "accountLogin");
  process.env.LOOP_TEST_MUSE_NO_MCP = "1";
  t.after(() => delete process.env.LOOP_TEST_MUSE_NO_MCP);
  const events: AdapterEvent[] = [];
  const adapter = new Muse(
    {
      ...options,
      workspaceTools: {
        url: "http://127.0.0.1:1234/mcp",
        token: "private-fixture",
      },
    },
    (e) => events.push(e),
  );
  try {
    await adapter.start();
    assert.equal(
      requests().find((r) => r.method === "session/start").params.config,
      undefined,
    );
    // Held until a prompt, when the run that shows it is attached.
    assert(!events.some((e) => e.type === "error"));
    await adapter.prompt("hello");
    assert(
      events.some(
        (e) =>
          e.type === "error" &&
          /workspace tools are unavailable/.test(e.message),
      ),
    );
  } finally {
    await adapter.dispose();
  }
});

test("Muse keeps a refused decision answerable", async (t) => {
  fixture(t, "accountLogin");
  const events: AdapterEvent[] = [];
  const adapter = new Muse(options, (e) => events.push(e));
  try {
    await adapter.start();
    await adapter.prompt("this needs approval, refuse first");
    await until(() => events.some((e) => e.type === "request"));
    const request = events.find((e) => e.type === "request");
    assert(request?.type === "request");
    await assert.rejects(
      adapter.answer(request.request.id, { choice: "allow" }),
      NotDelivered,
    );
    assert(!events.some((e) => e.type === "resolved"));
    await adapter.answer(request.request.id, { choice: "allow" });
    await until(() =>
      events.some((e) => e.type === "status" && e.status === "completed"),
    );
  } finally {
    await adapter.dispose();
  }
});

test("Muse declines a question prompt with no questions", async (t) => {
  const requests = fixture(t, "accountLogin");
  const events: AdapterEvent[] = [];
  const adapter = new Muse(options, (e) => events.push(e));
  try {
    await adapter.start();
    await adapter.prompt("empty input arrives");
    await until(() =>
      events.some((e) => e.type === "status" && e.status === "completed"),
    );
    assert.equal(
      requests().find((r) => r.method === "userInput/cancel").params
        .userInputId,
      "empty-1",
    );
    assert(!events.some((e) => e.type === "request"));
  } finally {
    await adapter.dispose();
  }
});

test("Muse keeps a native resolution when a racing decision is refused", async (t) => {
  fixture(t, "accountLogin");
  const events: AdapterEvent[] = [];
  const adapter = new Muse(options, (e) => events.push(e));
  try {
    await adapter.start();
    await adapter.prompt("this needs approval, resolved while deciding");
    await until(() => events.some((e) => e.type === "request"));
    const request = events.find((e) => e.type === "request");
    assert(request?.type === "request");
    const refused = await adapter
      .answer(request.request.id, { choice: "allow" })
      .catch((e) => e);
    assert(refused instanceof Error && !(refused instanceof NotDelivered));
    assert.equal(
      events.filter((e) => e.type === "resolved" && e.id === request.request.id)
        .length,
      1,
    );
  } finally {
    await adapter.dispose();
  }
});

test("Muse retires a shown approval when its command changes", async (t) => {
  fixture(t, "accountLogin");
  const events: AdapterEvent[] = [];
  const adapter = new Muse(options, (e) => events.push(e));
  try {
    await adapter.start();
    await adapter.prompt("this needs approval, then changes command");
    await until(() => events.filter((e) => e.type === "request").length === 2);
    const [first, second] = events.filter((e) => e.type === "request");
    assert(first.type === "request" && second.type === "request");
    assert.notEqual(first.request.id, second.request.id);
    assert(
      events.some((e) => e.type === "resolved" && e.id === first.request.id),
    );
    assert.match(second.request.detail, /rm -rf build/);
    await assert.rejects(
      adapter.answer(first.request.id, { choice: "allow" }),
      /expired/,
    );
  } finally {
    await adapter.dispose();
  }
});
