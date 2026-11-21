import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ClientSideConnection } from "@agentclientprotocol/sdk";
import { Antigravity } from "../src/adapters/antigravity.js";
import type { AdapterEvent } from "../src/adapters/events.js";
import { NotDelivered, type Options } from "../src/adapters/types.js";
import { until } from "./helpers/wait.js";

const options: Options = {
  harness: "antigravity",
  executable: resolve("test/fixtures/fake-antigravity-steering.mjs"),
  project: process.cwd(),
  billing: "existing",
  version: "1.5.2",
};
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "loop-agy-"));
  const path = join(dir, "requests");
  process.env.LOOP_TEST_AGY_LOG = path;
  t.after(() => {
    delete process.env.LOOP_TEST_AGY_LOG;
    delete process.env.LOOP_TEST_AGY_MODE;
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
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

test("Antigravity waits through successive reactive passes and approvals", async (t) => {
  const requests = fixture(t);
  process.env.LOOP_TEST_AGY_MODE = "reactive";
  const events: AdapterEvent[] = [];
  const adapter = new Antigravity({ ...options, version: "1.5.14" }, (e) =>
    events.push(e),
  );
  t.after(() => adapter.dispose());
  await adapter.start();
  await adapter.prompt("Run background work");
  await until(() => events.some((e) => e.type === "request"));
  const approval = events.find((e) => e.type === "request")!;
  assert.deepEqual(statuses(events), ["ready"]);
  assert.deepEqual(
    events.flatMap((e) => (e.type === "delta" ? [e.text] : [])),
    ["Waiting.", "Waiting again."],
  );
  await adapter.answer(approval.request.id, { choice: "allow" });
  await until(() =>
    events.some((e) => e.type === "delta" && e.text === "Done."),
  );
  assert.deepEqual(statuses(events), ["ready"]);
  assert.deepEqual(
    events.flatMap((e) => (e.type === "delta" ? [e.text] : [])),
    ["Waiting.", "Waiting again.", "Done."],
  );
  assert.deepEqual(prompts(requests), ["Run background work"]);
  await assert.rejects(adapter.prompt("Next turn"), /busy/);
});

for (const mode of [
  "daemon-only",
  "reactive-late-daemon",
  "reactive-rejected-steer-daemon",
  "reactive-late-tool-steer-daemon",
])
  test(`Antigravity completes normally with only a daemon still running in ${mode}`, async (t) => {
    fixture(t);
    process.env.LOOP_TEST_AGY_MODE = mode;
    const events: AdapterEvent[] = [];
    const adapter = new Antigravity({ ...options, version: "1.5.14" }, (e) =>
      events.push(e),
    );
    t.after(() => adapter.dispose());
    await adapter.start();
    await adapter.prompt("Start a daemon");
    if (mode === "reactive-late-tool-steer-daemon")
      await adapter.steer!("Keep going");
    if (mode === "reactive-rejected-steer-daemon")
      await assert.rejects(adapter.steer!("Keep going"), /Steer rejected/);
    await until(() => complete(events).length === 1);
    assert.deepEqual(statuses(events), ["ready", "completed"]);
  });

test("Antigravity keeps a failed daemon launch open for recovery output", async (t) => {
  fixture(t);
  process.env.LOOP_TEST_AGY_MODE = "reactive-daemon-failed";
  const events: AdapterEvent[] = [];
  const adapter = new Antigravity({ ...options, version: "1.5.14" }, (e) =>
    events.push(e),
  );
  t.after(() => adapter.dispose());
  await adapter.start();
  await adapter.prompt("Start a daemon");
  await until(() =>
    events.some((e) => e.type === "delta" && e.text === "Daemon failed."),
  );
  assert.deepEqual(statuses(events), ["ready"]);
});

for (const mode of [
  "reactive-steering",
  "reactive-rejected-steer-late-tool",
  "reactive-rejected-steer-settled-tool",
  "reactive-echoed-steer-settled-tool",
  "reactive-daemon-unechoed-steer-output",
  "reactive-steer-daemon",
])
  test(`Antigravity keeps accepting output after overlapping prompts in ${mode}`, async (t) => {
    const requests = fixture(t);
    process.env.LOOP_TEST_AGY_MODE = mode;
    const events: AdapterEvent[] = [];
    const adapter = new Antigravity({ ...options, version: "1.5.14" }, (e) =>
      events.push(e),
    );
    t.after(() => adapter.dispose());
    await adapter.start();
    await adapter.prompt("Run background work");
    await until(() => events.some((e) => e.type === "delta"));
    if (mode.includes("rejected") || mode.includes("unechoed"))
      await assert.rejects(adapter.steer!("Keep going"), /Steer rejected/);
    else await adapter.steer!("Keep going");
    await until(() =>
      events.some((e) => e.type === "delta" && e.text === "Done."),
    );
    assert.deepEqual(statuses(events), ["ready"]);
    assert.deepEqual(
      events.flatMap((e) => (e.type === "delta" ? [e.text] : [])),
      mode === "reactive-daemon-unechoed-steer-output"
        ? ["Daemon started.", "Waiting.", "Done."]
        : mode === "reactive-steer-daemon"
          ? ["Daemon started.", "Done."]
          : ["Waiting.", "Done."],
    );
    assert.deepEqual(prompts(requests), ["Run background work", "Keep going"]);
  });

for (const mode of ["reactive-sync-answer", "reactive-sync-subagent"])
  test(`Antigravity handles an async-capable tool that settles before end_turn in ${mode}`, async (t) => {
    fixture(t);
    process.env.LOOP_TEST_AGY_MODE = mode;
    const events: AdapterEvent[] = [];
    const adapter = new Antigravity({ ...options, version: "1.5.14" }, (e) =>
      events.push(e),
    );
    t.after(() => adapter.dispose());
    await adapter.start();
    await adapter.prompt("Run background work");
    await until(() =>
      events.some((e) => e.type === "delta" && e.text === "Done."),
    );
    await until(() => complete(events).length === 1);
    assert.deepEqual(
      events.flatMap((e) => (e.type === "delta" ? [e.text] : [])),
      mode === "reactive-sync-subagent" ? ["Done."] : ["Waiting.", "Done."],
    );
  });

test("Antigravity completes a synchronous tool-only turn at end_turn", async (t) => {
  fixture(t);
  process.env.LOOP_TEST_AGY_MODE = "reactive-tool-only";
  const events: AdapterEvent[] = [];
  const adapter = new Antigravity({ ...options, version: "1.5.14" }, (e) =>
    events.push(e),
  );
  t.after(() => adapter.dispose());
  await adapter.start();
  await adapter.prompt("Run the tool");
  await until(() => complete(events).length === 1, 2000);
});

test("Antigravity retires the live session when a steering limit interrupts reactive work", async (t) => {
  fixture(t);
  process.env.LOOP_TEST_AGY_MODE = "reactive-steer-limit";
  const events: AdapterEvent[] = [];
  const adapter = new Antigravity({ ...options, version: "1.5.14" }, (e) =>
    events.push(e),
  );
  t.after(() => adapter.dispose());
  await adapter.start();
  await adapter.prompt("Run background work");
  await assert.rejects(adapter.steer!("Keep going"), /max_tokens/);
  assert.deepEqual(statuses(events), ["ready", "interrupted"]);
  assert.equal(adapter.reusable, false);
  assert.equal(adapter.canReuse({ ...options, version: "1.5.14" }), false);
  await assert.rejects(adapter.prompt("Next turn"), /unavailable/);
});

test("Antigravity keeps accepting reactive output after echoing and acknowledging a steer", async (t) => {
  fixture(t);
  process.env.LOOP_TEST_AGY_MODE = "reactive-steer-ack";
  const events: AdapterEvent[] = [];
  const adapter = new Antigravity({ ...options, version: "1.5.14" }, (e) =>
    events.push(e),
  );
  t.after(() => adapter.dispose());
  await adapter.start();
  await adapter.prompt("Run background work");
  await adapter.steer!("Keep going");
  await until(() =>
    events.some((e) => e.type === "delta" && e.text === "Done."),
  );
  assert.deepEqual(statuses(events), ["ready"]);
  assert.deepEqual(
    events.flatMap((e) => (e.type === "delta" ? [e.text] : [])),
    ["Waiting.", "Acknowledged.", "Done."],
  );
});

for (const mode of ["reactive-stalled", "reactive-stalled-steer"])
  test(
    `Antigravity bounds the wait for ${mode}`,
    { timeout: 5000 },
    async (t) => {
      fixture(t);
      process.env.LOOP_TEST_AGY_MODE = mode;
      const events: AdapterEvent[] = [];
      let endPrompt!: () => void;
      const promptEnded = new Promise<void>((resolve) => {
        endPrompt = resolve;
      });
      const adapter = new Antigravity(
        { ...options, version: "1.5.14" },
        (e) => {
          events.push(e);
          if (e.type === "usage") endPrompt();
        },
      );
      t.after(() => adapter.dispose());
      await adapter.start();
      t.mock.timers.enable({ apis: ["setTimeout"] });
      try {
        await adapter.prompt("Run background work");
        await promptEnded;
        if (mode === "reactive-stalled-steer")
          await adapter.steer!("Keep going");
        t.mock.timers.tick(60_000);
        assert.deepEqual(statuses(events), ["ready"]);
        t.mock.timers.tick(59 * 60_000);
        assert.deepEqual(statuses(events), ["ready", "interrupted"]);
        assert.equal(adapter.reusable, false);
      } finally {
        t.mock.timers.reset();
      }
    },
  );

test("Antigravity cancels a reactive turn with an outstanding steering request", async (t) => {
  const requests = fixture(t);
  process.env.LOOP_TEST_AGY_MODE = "reactive-stalled-steer";
  const events: AdapterEvent[] = [];
  const adapter = new Antigravity({ ...options, version: "1.5.14" }, (e) =>
    events.push(e),
  );
  t.after(() => adapter.dispose());
  await adapter.start();
  await adapter.prompt("Run background work");
  await until(() => events.some((e) => e.type === "usage"));
  await adapter.steer!("Keep going");
  await adapter.cancel();
  await until(() => requests().some((r) => r.acp === "session/cancel"));
  assert.deepEqual(statuses(events), ["ready", "interrupted"]);
  assert.equal(adapter.reusable, false);
});

test("Antigravity reports interruption before a blocked cancel notification settles", async (t) => {
  fixture(t);
  process.env.LOOP_TEST_AGY_MODE = "reactive-stalled";
  const events: AdapterEvent[] = [];
  const adapter = new Antigravity({ ...options, version: "1.5.14" }, (e) =>
    events.push(e),
  );
  t.after(() => adapter.dispose());
  await adapter.start();
  await adapter.prompt("Run background work");
  await until(() => events.some((e) => e.type === "usage"));
  let deliver!: () => void;
  t.mock.method(
    ClientSideConnection.prototype,
    "cancel",
    () =>
      new Promise<void>((resolve) => {
        deliver = resolve;
      }),
  );
  const cancelled = adapter.cancel();
  try {
    assert.deepEqual(statuses(events), ["ready", "interrupted"]);
    assert.equal(adapter.reusable, false);
  } finally {
    deliver();
    await cancelled;
  }
});

test(
  "Antigravity pauses the reactive budget during approval and resumes with the remaining time",
  { timeout: 5000 },
  async (t) => {
    fixture(t);
    process.env.LOOP_TEST_AGY_MODE = "reactive-budget";
    const events: AdapterEvent[] = [];
    let endPrompt!: () => void;
    const promptEnded = new Promise<void>((resolve) => {
      endPrompt = resolve;
    });
    let requestApproval!: (id: string) => void;
    const approval = new Promise<string>((resolve) => {
      requestApproval = resolve;
    });
    const adapter = new Antigravity({ ...options, version: "1.5.14" }, (e) => {
      events.push(e);
      if (e.type === "usage") endPrompt();
      if (e.type === "request") requestApproval(e.request.id);
    });
    t.after(() => adapter.dispose());
    await adapter.start();
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    t.mock.method(performance, "now", () => Date.now());
    try {
      await adapter.prompt("Run background work");
      await promptEnded;
      t.mock.timers.tick(59 * 60_000);
      await adapter.steer!("Keep going");
      const decisionId = await approval;
      t.mock.timers.tick(60 * 60_000);
      assert.deepEqual(statuses(events), ["ready"]);
      await adapter.answer(decisionId, { choice: "allow" });
      t.mock.timers.tick(5_000);
      assert.deepEqual(statuses(events), ["ready"]);
      t.mock.timers.tick(55_000);
      assert.deepEqual(statuses(events), ["ready", "interrupted"]);
    } finally {
      t.mock.timers.reset();
    }
  },
);

for (const mode of ["reactive-reordered", "reactive-final-usage"])
  test(
    `Antigravity preserves partial output and interrupts in ${mode}`,
    { timeout: 5000 },
    async (t) => {
      fixture(t);
      process.env.LOOP_TEST_AGY_MODE = mode;
      const events: AdapterEvent[] = [];
      let settle!: () => void;
      const settled = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const adapter = new Antigravity(
        { ...options, version: "1.5.14" },
        (e) => {
          events.push(e);
          if (
            e.type === "activity" &&
            e.activity.kind === "tool" &&
            e.activity.id === "background" &&
            e.activity.patch.status === "completed"
          )
            settle();
        },
      );
      t.after(() => adapter.dispose());
      await adapter.start();
      t.mock.timers.enable({ apis: ["setTimeout"] });
      try {
        await adapter.prompt("Run background work");
        await settled;
        assert.deepEqual(statuses(events), ["ready"]);
        t.mock.timers.tick(5_000);
        assert.deepEqual(statuses(events), ["ready"]);
        t.mock.timers.tick(55_000);
        assert.deepEqual(statuses(events), ["ready", "interrupted"]);
        assert.equal(adapter.reusable, false);
      } finally {
        t.mock.timers.reset();
      }
    },
  );

for (const stop of ["cancel", "dispose"] as const)
  test(`Antigravity ${stop} can stop a turn waiting for a reactive wakeup`, async (t) => {
    const requests = fixture(t);
    process.env.LOOP_TEST_AGY_MODE = "reactive-stalled";
    const events: AdapterEvent[] = [];
    const adapter = new Antigravity({ ...options, version: "1.5.14" }, (e) =>
      events.push(e),
    );
    t.after(() => adapter.dispose());
    await adapter.start();
    await adapter.prompt("Wait for background work");
    await until(() => events.some((e) => e.type === "usage"));
    assert.deepEqual(statuses(events), ["ready"]);
    await adapter[stop]();
    if (stop === "cancel") {
      await until(() => requests().some((r) => r.acp === "session/cancel"));
      assert.deepEqual(statuses(events), ["ready", "interrupted"]);
      assert.equal(adapter.reusable, false);
    } else {
      assert.deepEqual(statuses(events), ["ready"]);
    }
  });

for (const version of ["1.5.2", "1.5.9"])
  test(`Antigravity ${version} waits for delayed discovery before framing a slash-leading steer`, async (t) => {
    const requests = fixture(t);
    process.env.LOOP_TEST_AGY_MODE = "delayed-commands";
    const events: AdapterEvent[] = [];
    const adapter = new Antigravity({ ...options, version }, (e) =>
      events.push(e),
    );
    try {
      await adapter.start();
      await adapter.prompt("[slow] Ordinary initial task");
      await until(() => events.some((e) => e.type === "delta"));
      assert.deepEqual(adapter.commands, []);
      await adapter.steer!("/plan investigate");
      assert.deepEqual(prompts(requests), [
        "[slow] Ordinary initial task",
        "/plan investigate",
      ]);
    } finally {
      await adapter.dispose();
    }
  });

for (const version of ["1.5.2", "1.5.9"])
  for (const stop of ["cancel", "dispose"] as const)
    test(`Antigravity ${version} ${stop} refuses a slash steer still waiting for discovery`, async (t) => {
      const requests = fixture(t);
      process.env.LOOP_TEST_AGY_MODE = "acp-silent";
      const events: AdapterEvent[] = [];
      const adapter = new Antigravity({ ...options, version }, (e) =>
        events.push(e),
      );
      let dispatched = false;
      try {
        await adapter.start();
        await adapter.prompt("[slow] Ordinary initial task");
        await until(() => events.some((e) => e.type === "delta"));
        const pending = assert.rejects(
          adapter.steer!("/plan must not dispatch", () => {
            dispatched = true;
          }),
          (error) => {
            assert(error instanceof NotDelivered);
            return true;
          },
        );
        await adapter[stop]();
        await pending;
        assert.equal(dispatched, false);
        assert.deepEqual(prompts(requests), ["[slow] Ordinary initial task"]);
      } finally {
        await adapter.dispose();
      }
    });

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

for (const version of ["1.5.2", "1.5.9"])
  test(`Antigravity ${version} steers a running turn with a concurrent prompt and completes the run once`, async (t) => {
    const requests = fixture(t);
    const events: AdapterEvent[] = [];
    const adapter = new Antigravity(
      { ...options, version, instructions: "Saved instructions" },
      (e) => events.push(e),
    );
    try {
      await adapter.start();
      await adapter.prompt("[slow] Write an essay");
      await until(() => events.some((e) => e.type === "delta"));
      await adapter.steer!("Change course");
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
    await adapter.steer!("/plan the rest");
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
    await assert.rejects(adapter.steer!("No turn"), NotDelivered);
    await adapter.prompt("[approve] Needs approval");
    await until(() => events.some((e) => e.type === "request"));
    await assert.rejects(adapter.steer!("During approval"), NotDelivered);
    const approval = events.find((e) => e.type === "request");
    assert(approval?.type === "request");
    await adapter.answer(approval.request.id, { choice: "allow" });
    await until(() => complete(events).length === 1);
    await adapter.prompt("[slow] Long task");
    await until(() =>
      events.some((e) => e.type === "delta" && e.text === "Partial essay"),
    );
    await assert.rejects(
      adapter.steer!("Refused", () => {
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
    await assert.rejects(adapter.steer!("Follow-up"), (error) => {
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
    const steer = adapter.steer!("Follow-up");
    await new Promise((r) => setTimeout(r, 100));
    await adapter.cancel();
    await assert.rejects(
      steer,
      /ended \(cancelled\) before steering was confirmed/,
    );
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
    const steer = adapter.steer!("Follow-up");
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

test("Antigravity never confirms a steer from the turn's own prompt echo", async (t) => {
  const requests = fixture(t);
  process.env.LOOP_TEST_AGY_MODE = "late-echo-reject-steer";
  const events: AdapterEvent[] = [];
  const adapter = new Antigravity(options, (e) => events.push(e));
  try {
    await adapter.start();
    await adapter.prompt("[slow] Did it rain yesterday?");
    // Sent before agy echoes the prompt, whose text contains "yes".
    await assert.rejects(adapter.steer!("yes"), (error) => {
      assert(!(error instanceof NotDelivered));
      return true;
    });
    assert.deepEqual(prompts(requests), [
      "[slow] Did it rain yesterday?",
      "yes",
    ]);
  } finally {
    await adapter.dispose();
  }
});

test("Antigravity confirms a bare steered command, which agy echoes empty, only by its request", async (t) => {
  const requests = fixture(t);
  const events: AdapterEvent[] = [];
  const adapter = new Antigravity(options, (e) => events.push(e));
  try {
    await adapter.start();
    await adapter.prompt("[slow] Long task");
    await until(() => events.some((e) => e.type === "delta"));
    await adapter.steer!("/plan");
    await until(() => complete(events).length === 1);
    assert.deepEqual(prompts(requests), ["[slow] Long task", "/plan"]);
  } finally {
    await adapter.dispose();
  }
});

test("Antigravity keeps slash-leading saved instructions from expanding as a command", async (t) => {
  const requests = fixture(t);
  const events: AdapterEvent[] = [];
  const adapter = new Antigravity(
    { ...options, instructions: "/plan review carefully" },
    (e) => events.push(e),
  );
  try {
    await adapter.start();
    await adapter.prompt("Explain this function");
    await until(() => complete(events).length === 1);
    assert.deepEqual(prompts(requests), [
      "\u200b/plan review carefully\n\nExplain this function",
    ]);
  } finally {
    await adapter.dispose();
  }
});

test("Antigravity fails setup without a prompt when agy never applies the thinking level", async (t) => {
  const requests = fixture(t);
  process.env.LOOP_TEST_AGY_MODE = "config-hang";
  const adapter = new Antigravity({ ...options, effort: "high" }, () => {});
  const started = Date.now();
  try {
    await assert.rejects(
      adapter.start(),
      /did not confirm startup configuration/,
    );
    assert(Date.now() - started < 20000);
    assert.equal(prompts(requests).length, 0);
  } finally {
    await adapter.dispose();
  }
});

test("Antigravity waits for the whole prompt echo before steering, so a split echo never confirms it", async (t) => {
  const requests = fixture(t);
  process.env.LOOP_TEST_AGY_MODE = "split-echo-reject-steer";
  const adapter = new Antigravity(options, () => {});
  try {
    await adapter.start();
    await adapter.prompt("[slow] Say yes");
    // agy echoes "[slow] Say " now and "yes" 300 ms later, then rejects.
    await assert.rejects(adapter.steer!("yes"), (error) => {
      assert(!(error instanceof NotDelivered));
      return true;
    });
    assert.deepEqual(prompts(requests), ["[slow] Say yes", "yes"]);
  } finally {
    await adapter.dispose();
  }
});

test("Antigravity reports the turn completed when agy ends it and then rejects a steer it never took", async (t) => {
  fixture(t);
  process.env.LOOP_TEST_AGY_MODE = "end-then-reject-steer";
  const events: AdapterEvent[] = [];
  const adapter = new Antigravity(options, (e) => events.push(e));
  try {
    await adapter.start();
    await adapter.prompt("[slow] Long task");
    await until(() => events.some((e) => e.type === "delta"));
    await assert.rejects(adapter.steer!("Follow-up"), (error) => {
      assert(!(error instanceof NotDelivered));
      return true;
    });
    await until(() => statuses(events).length === 2);
    assert.deepEqual(statuses(events), ["ready", "completed"]);
  } finally {
    await adapter.dispose();
  }
});

test("Antigravity disposed during its sign-in check never starts agy acp", async (t) => {
  const requests = fixture(t);
  process.env.LOOP_TEST_AGY_MODE = "slow-models";
  const adapter = new Antigravity(options, () => {});
  const start = adapter.start();
  start.catch(() => {});
  await adapter.dispose();
  await assert.rejects(start);
  await new Promise((r) => setTimeout(r, 300));
  assert(!requests().some((r) => r.args?.[0] === "acp"));
});

test("Antigravity keeps slash text other than a discovered command literal", async (t) => {
  const requests = fixture(t);
  const events: AdapterEvent[] = [];
  const adapter = new Antigravity(options, (e) => events.push(e));
  try {
    await adapter.start();
    for (const text of ["/help me", "/tmp/notes.txt summarise", "/plan this"]) {
      const before = complete(events).length;
      await adapter.prompt(text);
      await until(() => complete(events).length === before + 1);
    }
    await adapter.prompt("[slow] Long task");
    await until(() =>
      events.some((e) => e.type === "delta" && e.text === "Partial essay"),
    );
    await adapter.steer!("/logout now");
    await until(() => complete(events).length === 4);
    assert.deepEqual(prompts(requests), [
      "\u200b/help me",
      "\u200b/tmp/notes.txt summarise",
      "/plan this",
      "[slow] Long task",
      "\u200b/logout now",
    ]);
  } finally {
    await adapter.dispose();
  }
});

test("Antigravity does not confirm a steer whose request stops at a limit without its echo", async (t) => {
  fixture(t);
  process.env.LOOP_TEST_AGY_MODE = "steer-limit";
  const events: AdapterEvent[] = [];
  const adapter = new Antigravity(options, (e) => events.push(e));
  try {
    await adapter.start();
    await adapter.prompt("[slow] Long task");
    await until(() => events.some((e) => e.type === "delta"));
    await assert.rejects(adapter.steer!("Follow-up"), /ended \(max_tokens\)/);
    await until(() => statuses(events).includes("interrupted"));
  } finally {
    await adapter.dispose();
  }
});

test("Antigravity matches a steer's echo exactly, not with inner whitespace removed", async (t) => {
  fixture(t);
  process.env.LOOP_TEST_AGY_MODE = "steer-mangled-echo-reject";
  const events: AdapterEvent[] = [];
  const adapter = new Antigravity(options, (e) => events.push(e));
  try {
    await adapter.start();
    await adapter.prompt("[slow] Long task");
    await until(() => events.some((e) => e.type === "delta"));
    await assert.rejects(adapter.steer!("approve now"), (error) => {
      assert(!(error instanceof NotDelivered));
      return true;
    });
  } finally {
    await adapter.dispose();
  }
});
