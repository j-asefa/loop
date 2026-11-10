import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { groupAlive, groupMembers } from "../src/daemon.js";
import { Acp } from "../src/adapters/acp.js";
import {
  reduceActivity,
  type ActivityRecord,
} from "../src/shared/agent-activities.js";
import type { AdapterEvent } from "../src/adapters/events.js";

const fixture = fileURLToPath(
  new URL("./fixtures/fake-acp.mjs", import.meta.url),
);
const wait = (events: AdapterEvent[], status: string) =>
  new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 3000;
    const poll = () => {
      if (events.some((e) => e.type === "status" && e.status === status))
        return resolve();
      if (Date.now() > deadline)
        return reject(new Error("Timed out waiting for " + status));
      setTimeout(poll, 10);
    };
    poll();
  });

test("ACP start, prompt, and stop map to native events", async () => {
  const events: AdapterEvent[] = [];
  const adapter = new Acp(
    {
      harness: "acp",
      executable: process.execPath,
      args: [fixture],
      project: process.cwd(),
      billing: "existing",
      version: "fake",
    },
    (e) => events.push(e),
  );
  try {
    await adapter.start();
    assert.equal(
      events.find((e) => e.type === "metadata")?.nativeSession,
      "fake-session",
    );
    await adapter.prompt("hello");
    await wait(events, "completed");
    assert(events.some((e) => e.type === "delta" && e.text === "answer"));
  } finally {
    await adapter.dispose();
  }
});

test("ACP load replay is not emitted as a new turn", async () => {
  const events: AdapterEvent[] = [];
  const adapter = new Acp(
    {
      harness: "acp",
      executable: process.execPath,
      args: [fixture],
      project: process.cwd(),
      billing: "existing",
      version: "fake",
      resume: "fake-session",
    },
    (e) => events.push(e),
  );
  try {
    await adapter.start();
    assert(!events.some((e) => e.type === "delta"));
  } finally {
    await adapter.dispose();
  }
});

test("ACP rejects unsupported load without replacing the session", async () => {
  const adapter = new Acp(
    {
      harness: "acp",
      executable: process.execPath,
      args: [fixture, "no-load"],
      project: process.cwd(),
      billing: "existing",
      version: "fake",
      resume: "existing",
    },
    () => {},
  );
  try {
    await assert.rejects(adapter.start(), /does not advertise session\/load/);
  } finally {
    await adapter.dispose();
  }
});

test("ACP rejects incompatible protocol versions", async () => {
  const adapter = new Acp(
    {
      harness: "acp",
      executable: process.execPath,
      args: [fixture, "wrong-version"],
      project: process.cwd(),
      billing: "existing",
      version: "fake",
    },
    () => {},
  );
  try {
    await assert.rejects(adapter.start(), /unsupported/);
  } finally {
    await adapter.dispose();
  }
});

test("ACP setup errors and authentication hints omit agent-supplied secrets", async () => {
  const events: AdapterEvent[] = [];
  const adapter = new Acp(
    {
      harness: "acp",
      executable: process.execPath,
      args: [fixture, "secret-setup"],
      project: process.cwd(),
      billing: "existing",
      version: "fake",
    },
    (event) => events.push(event),
  );
  try {
    await assert.rejects(
      adapter.start(),
      /Check the agent executable, local sign-in/,
    );
    assert(!JSON.stringify(events).includes("secret-"));
  } finally {
    await adapter.dispose();
  }
});

test("ACP process crash fails the active turn", async () => {
  const events: AdapterEvent[] = [];
  const adapter = new Acp(
    {
      harness: "acp",
      executable: process.execPath,
      args: [fixture, "crash"],
      project: process.cwd(),
      billing: "existing",
      version: "fake",
    },
    (e) => events.push(e),
  );
  try {
    await adapter.start();
    await adapter.prompt("hello");
    await wait(events, "failed");
  } finally {
    await adapter.dispose();
  }
});

test("ACP SDK failures expose fixed guidance in events and setting records", async () => {
  const events: AdapterEvent[] = [];
  const adapter = new Acp(
    {
      harness: "acp",
      executable: process.execPath,
      args: [fixture, "secret-errors"],
      project: process.cwd(),
      billing: "existing",
      version: "fake",
    },
    (event) => events.push(event),
  );
  try {
    await adapter.start();
    await assert.rejects(
      adapter.setSetting("level", "deep", adapter.settings.revision),
      /Check the agent's local login and logs/,
    );
    const setting = adapter.settings.options.find(
      (option) => option.id === "level",
    );
    assert.match(setting?.rejected || "", /refresh settings and retry/);
    assert.equal(setting?.requested, null);
    await adapter.prompt("hello");
    await wait(events, "failed");
    const failure = events.find(
      (event) => event.type === "status" && event.status === "failed",
    );
    assert(failure?.type === "status");
    assert.match(
      failure.detail || "",
      /Check the agent's local login and logs/,
    );
    assert(
      !JSON.stringify({ events, settings: adapter.settings }).includes(
        "secret-",
      ),
    );
  } finally {
    await adapter.dispose();
  }
});

test("ACP prompt failures name a provider billing status without its message", async () => {
  const events: AdapterEvent[] = [];
  const adapter = new Acp(
    {
      harness: "acp",
      executable: process.execPath,
      args: [fixture, "billing-error"],
      project: process.cwd(),
      billing: "existing",
      version: "fake",
    },
    (event) => events.push(event),
  );
  try {
    await adapter.start();
    await adapter.prompt("hello");
    await wait(events, "failed");
    const failure = events.find(
      (event) => event.type === "status" && event.status === "failed",
    );
    assert(failure?.type === "status");
    assert.match(failure.detail || "", /out of credits/);
    assert.doesNotMatch(failure.detail || "", /local login/);
    assert(!JSON.stringify(events).includes("secret-"));
  } finally {
    await adapter.dispose();
  }
});

test("ACP rejects an oversized JSONL frame before parsing", async () => {
  const events: AdapterEvent[] = [];
  const adapter = new Acp(
    {
      harness: "acp",
      executable: process.execPath,
      args: [fixture, "oversized-frame"],
      project: process.cwd(),
      billing: "existing",
      version: "fake",
    },
    (e) => events.push(e),
  );
  try {
    await adapter.start();
    await adapter.prompt("trigger oversized frame");
    await wait(events, "failed");
    assert(!events.some((e) => e.type === "delta"));
    assert.equal(
      events.filter((e) => e.type === "status" && e.status === "failed").length,
      1,
    );
  } finally {
    await adapter.dispose();
  }
});

test("ACP rich updates use shared activity records and dynamic catalog replacement", async () => {
  const events: AdapterEvent[] = [];
  const adapter = new Acp(
    {
      harness: "acp",
      executable: process.execPath,
      args: [fixture, "rich"],
      project: process.cwd(),
      billing: "existing",
      version: "fake",
    },
    (e) => events.push(e),
  );
  try {
    await adapter.start();
    assert.equal(
      adapter.settings.options.find((x) => x.id === "level")?.confirmed,
      "normal",
    );
    await adapter.prompt("inspect");
    await wait(events, "completed");
    const activities = events
      .filter(
        (e): e is Extract<AdapterEvent, { type: "activity" }> =>
          e.type === "activity",
      )
      .map((e) => e.activity);
    assert(
      activities.some(
        (a) =>
          a.kind === "plan" && a.patch.steps?.[1]?.status === "in_progress",
      ),
    );
    assert(
      activities.some(
        (a) =>
          a.kind === "file_change" && a.patch.files?.[0]?.after === "after",
      ),
    );
    assert(
      activities.some(
        (a) => a.kind === "tool" && a.patch.status === "completed",
      ),
    );
    assert(
      activities.some(
        (a) =>
          a.kind === "output" && a.patch.unavailable?.includes("did not host"),
      ),
    );
    assert(
      activities.some(
        (a) =>
          a.kind === "output" && a.patch.replace?.[0]?.text === "checks passed",
      ),
    );
    assert(
      activities.some(
        (a) =>
          a.kind === "tool" &&
          a.id === "edit-1" &&
          a.patch.content?.some((c) => c.type === "file_change"),
      ),
    );
    assert.equal(adapter.commandCatalog.commands.length, 0);
    assert(adapter.commandCatalog.revision >= 2);
    assert(!events.some((e) => e.type === "item" && e.item.kind === "tool"));
  } finally {
    await adapter.dispose();
  }
});

test("ACP setting writes are revision checked and confirmed by the agent", async () => {
  const adapter = new Acp(
    {
      harness: "acp",
      executable: process.execPath,
      args: [fixture, "rich"],
      project: process.cwd(),
      billing: "existing",
      version: "fake",
    },
    () => {},
  );
  try {
    await adapter.start();
    const revision = adapter.settings.revision;
    let authorized = 0;
    const authorize = () => {
      authorized++;
    };
    const result = await adapter.setSetting(
      "level",
      "deep",
      revision,
      authorize,
    );
    assert.equal(authorized, 1);
    assert.equal(
      result.options.find((x) => x.id === "level")?.confirmed,
      "deep",
    );
    assert.equal(
      result.options.find((x) => x.id === "level")?.requested,
      undefined,
    );
    await assert.rejects(
      adapter.setSetting("level", "normal", revision, authorize),
      /Refresh/,
    );
    assert.equal(authorized, 1);
    const mode = await adapter.setSetting(
      "acp-mode",
      "code",
      adapter.settings.revision,
    );
    assert.equal(
      mode.options.find((x) => x.id === "acp-mode")?.confirmed,
      "code",
    );
  } finally {
    await adapter.dispose();
  }
});

test("ACP removes withdrawn settings from the durable activity projection", async () => {
  const events: AdapterEvent[] = [];
  const adapter = new Acp(
    {
      harness: "acp",
      executable: process.execPath,
      args: [fixture, "remove-setting"],
      project: process.cwd(),
      billing: "existing",
      version: "fake",
    },
    (event) => events.push(event),
  );
  try {
    await adapter.start();
    assert(adapter.settings.options.some((option) => option.id === "level"));
    await adapter.prompt("refresh controls");
    await wait(events, "completed");
    assert(!adapter.settings.options.some((option) => option.id === "level"));
    assert(
      events.some(
        (event) =>
          event.type === "activity" &&
          event.activity.kind === "settings" &&
          event.activity.patch.remove?.includes("level"),
      ),
    );
  } finally {
    await adapter.dispose();
  }
});

test("ACP permission returns only one-shot options and settles once", async () => {
  const events: AdapterEvent[] = [];
  const adapter = new Acp(
    {
      harness: "acp",
      executable: process.execPath,
      args: [fixture, "permission"],
      project: process.cwd(),
      billing: "existing",
      version: "fake",
    },
    (e) => events.push(e),
  );
  try {
    await adapter.start();
    await adapter.prompt("change file");
    const deadline = Date.now() + 3000;
    while (!events.some((e) => e.type === "request") && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10));
    const decision = events.find(
      (e): e is Extract<AdapterEvent, { type: "request" }> =>
        e.type === "request",
    );
    assert(decision);
    assert.deepEqual(decision.request.choices, ["once-yes", "once-no"]);
    await assert.rejects(
      adapter.answer(decision.request.id, { choice: "always" }),
      /listed/,
    );
    await adapter.answer(decision.request.id, { choice: "once-no" });
    await assert.rejects(
      adapter.answer(decision.request.id, { choice: "once-yes" }),
      /expired/,
    );
    await wait(events, "completed");
    assert.equal(events.filter((e) => e.type === "resolved").length, 1);
  } finally {
    await adapter.dispose();
  }
});

test("ACP rejects one-shot options omitted by the display bound", async () => {
  const events: AdapterEvent[] = [];
  const adapter = new Acp(
    {
      harness: "acp",
      executable: process.execPath,
      args: [fixture, "permission-bounded"],
      project: process.cwd(),
      billing: "existing",
      version: "fake",
    },
    (event) => events.push(event),
  );
  try {
    await adapter.start();
    await adapter.prompt("change file");
    const deadline = Date.now() + 3000;
    while (
      !events.some((event) => event.type === "request") &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    const decision = events.find(
      (event): event is Extract<AdapterEvent, { type: "request" }> =>
        event.type === "request",
    );
    assert(decision);
    assert.equal(decision.request.choices?.length, 25);
    assert(!decision.request.choices?.includes("hidden"));
    await assert.rejects(
      adapter.answer(decision.request.id, { choice: "hidden" }),
      /listed/,
    );
    await adapter.answer(decision.request.id, { choice: "once-no" });
    await wait(events, "completed");
  } finally {
    await adapter.dispose();
  }
});

test("ACP keeps settings writes and prompts serialized", async () => {
  const events: AdapterEvent[] = [];
  const adapter = new Acp(
    {
      harness: "acp",
      executable: process.execPath,
      args: [fixture, "slow-setting"],
      project: process.cwd(),
      billing: "existing",
      version: "fake",
    },
    (e) => events.push(e),
  );
  try {
    await adapter.start();
    const setting = adapter.setSetting(
      "level",
      "deep",
      adapter.settings.revision,
    );
    await assert.rejects(adapter.prompt("overlapping turn"), /busy/);
    assert.equal(
      (await setting).options.find((x) => x.id === "level")?.confirmed,
      "deep",
    );
    await adapter.prompt("after setting");
    await wait(events, "completed");
  } finally {
    await adapter.dispose();
  }
});

test("ACP cancellation settles a pending permission once and rejects late answers", async () => {
  const events: AdapterEvent[] = [];
  const adapter = new Acp(
    {
      harness: "acp",
      executable: process.execPath,
      args: [fixture, "permission"],
      project: process.cwd(),
      billing: "existing",
      version: "fake",
    },
    (e) => events.push(e),
  );
  try {
    await adapter.start();
    await adapter.prompt("change file");
    const deadline = Date.now() + 3000;
    while (!events.some((e) => e.type === "request") && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10));
    const request = events.find(
      (e): e is Extract<AdapterEvent, { type: "request" }> =>
        e.type === "request",
    );
    assert(request);
    await adapter.cancel();
    await adapter.cancel();
    await wait(events, "interrupted");
    assert.equal(
      events.filter((e) => e.type === "resolved" && e.id === request.request.id)
        .length,
      1,
    );
    await assert.rejects(
      adapter.answer(request.request.id, { choice: "once-yes" }),
      /expired/,
    );
  } finally {
    await adapter.dispose();
  }
});

test("ACP ignores turn output after completion and refuses disposed prompts", async () => {
  const events: AdapterEvent[] = [];
  const adapter = new Acp(
    {
      harness: "acp",
      executable: process.execPath,
      args: [fixture, "late-update"],
      project: process.cwd(),
      billing: "existing",
      version: "fake",
    },
    (e) => events.push(e),
  );
  await adapter.start();
  await adapter.prompt("first");
  await wait(events, "completed");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert(!events.some((e) => e.type === "delta" && e.text === "late answer"));
  await adapter.dispose();
  await assert.rejects(adapter.prompt("after close"), /unavailable/);
});

test("ACP partial tool updates retain all diffs, lifecycle, and command output", async () => {
  const events: AdapterEvent[] = [];
  const records = new Map<string, ActivityRecord>();
  const adapter = new Acp(
    {
      harness: "acp",
      executable: process.execPath,
      args: [fixture, "partial-tools"],
      project: process.cwd(),
      billing: "existing",
      version: "fake",
    },
    (event) => {
      events.push(event);
      if (event.type !== "activity") return;
      const key = `${event.activity.kind}:${event.activity.id}`;
      const result = reduceActivity(records.get(key), event.activity);
      if (result.record) {
        // Round-trip each revision as persisted history before applying the next patch.
        records.set(key, JSON.parse(JSON.stringify(result.record)));
      }
    },
  );
  try {
    await adapter.start();
    await adapter.prompt("partial updates");
    await wait(events, "completed");
    for (const status of ["completed", "failed"]) {
      const edit = records.get(`tool:edit-${status}`);
      assert(edit?.kind === "tool");
      assert.equal(edit.data.status, status);
      assert.equal(edit.data.category, "edit");
      assert.deepEqual(edit.data.content, [
        { type: "file_change", activity: `edit-${status}:diff` },
      ]);
      const diff = records.get(`file_change:edit-${status}:diff`);
      assert(diff?.kind === "file_change");
      assert.equal(
        diff.data.state,
        status === "completed" ? "applied" : "failed",
      );
      assert.deepEqual(
        diff.data.files.map(({ path, operation, before, after }) => ({
          path,
          operation,
          before,
          after,
        })),
        [
          { path: "/a", operation: "modify", before: "old a", after: "new a" },
          { path: "/b", operation: "create", before: null, after: "new b" },
        ],
      );
      for (const initialOutput of [false, true]) {
        const id = `exec-${status}-${initialOutput}`;
        const tool = records.get(`tool:${id}`);
        assert(tool?.kind === "tool");
        assert.equal(tool.data.status, status);
        assert.equal(tool.data.category, "execute");
        assert(
          tool.data.content?.some(
            (entry) =>
              entry.type === "output" && entry.activity === `${id}:output`,
          ),
        );
        const output = records.get(`output:${id}:output`);
        assert(output?.kind === "output");
        assert.equal(
          output.data.status,
          status === "completed" ? "exited" : "failed",
        );
        assert.deepEqual(
          output.data.chunks.map(({ text }) => text),
          ["final output"],
        );
        assert(
          events.some(
            (event) =>
              event.type === "activity" &&
              event.activity.kind === "tool" &&
              event.activity.id === id &&
              event.activity.patch.status === "running" &&
              event.activity.patch.content?.some(
                (entry) => entry.type === "text" && entry.text === "working",
              ),
          ),
        );
      }
    }
  } finally {
    await adapter.dispose();
  }
});

for (const mode of ["replaced-diffs", "bounded-diffs"]) {
  test(`ACP persists file changes through ${mode}`, async () => {
    const events: AdapterEvent[] = [];
    const records = new Map<string, ActivityRecord>();
    const adapter = new Acp(
      {
        harness: "acp",
        executable: process.execPath,
        args: [fixture, mode],
        project: process.cwd(),
        billing: "existing",
        version: "fake",
      },
      (event) => {
        events.push(event);
        if (event.type !== "activity") return;
        const key = `${event.activity.kind}:${event.activity.id}`;
        const result = reduceActivity(records.get(key), event.activity);
        assert(result.record);
        records.set(key, JSON.parse(JSON.stringify(result.record)));
      },
    );
    try {
      await adapter.start();
      await adapter.prompt("edit files");
      await wait(events, "completed");
      assert(!events.some((event) => event.type === "error"));
      const check = (
        id: string,
        status: string,
        paths: string[],
        omitted = 0,
      ) => {
        const diff = records.get(`file_change:${id}:diff`);
        assert(diff?.kind === "file_change");
        assert.equal(
          diff.data.state,
          status === "completed" ? "applied" : "failed",
        );
        assert.deepEqual(
          diff.data.files.map((file) => file.path),
          paths,
        );
        assert(
          diff.data.files.every(
            (file) => file.before === "before" && file.after === "after",
          ),
        );
        const tool = records.get(`tool:${id}`);
        assert(tool?.kind === "tool");
        assert.equal(tool.data.status, status);
        assert.deepEqual(
          tool.data.content?.filter((entry) => entry.type === "file_change"),
          [{ type: "file_change", activity: `${id}:diff` }],
        );
        const notices =
          tool.data.content?.filter((entry) => entry.type === "unavailable") ||
          [];
        assert.equal(notices.length, omitted ? 1 : 0);
        if (omitted)
          assert.equal(
            notices[0].reason,
            `Showing the first 200 files; ${omitted} additional diffs omitted from display.`,
          );
      };
      if (mode === "replaced-diffs") {
        for (const status of ["completed", "failed"])
          for (const replacement of ["text", "empty"])
            for (const combined of [false, true]) {
              const id = `replace-${status}-${replacement}-${combined}`;
              check(id, status, ["/retained"]);
              const tool = records.get(`tool:${id}`);
              assert(tool?.kind === "tool");
              assert.deepEqual(
                tool.data.content?.filter((entry) => entry.type === "text"),
                replacement === "text"
                  ? [{ type: "text", text: "Done editing" }]
                  : [],
              );
            }
      } else {
        for (const count of [200, 201, 250])
          check(
            `large-${count}`,
            "completed",
            Array.from({ length: 200 }, (_, i) => `/file-${i}`),
            count - 200,
          );
      }
    } finally {
      await adapter.dispose();
    }
  });
}

test("ACP probes initialize without creating or loading sessions", async () => {
  for (const resume of [undefined, "existing-session"]) {
    const events: AdapterEvent[] = [];
    const adapter = new Acp(
      {
        harness: "acp",
        executable: process.execPath,
        args: [fixture, "probe-only"],
        project: process.cwd(),
        billing: "existing",
        version: "fake",
        probeOnly: true,
        resume,
      },
      (event) => events.push(event),
    );
    try {
      assert.equal((await adapter.start()).mode, "existing");
      assert.equal(adapter.capabilities.resume, true);
      assert.equal(adapter.activityCapabilities.tools.state, "supported");
      assert.deepEqual(adapter.commands, []);
      assert(!events.some((event) => event.type === "metadata"));
    } finally {
      await adapter.dispose();
    }
  }
});

test("ACP command output survives empty and non-text content replacement", async () => {
  const events: AdapterEvent[] = [];
  const records = new Map<string, ActivityRecord>();
  const adapter = new Acp(
    {
      harness: "acp",
      executable: process.execPath,
      args: [fixture, "replaced-output"],
      project: process.cwd(),
      billing: "existing",
      version: "fake",
    },
    (event) => {
      events.push(event);
      if (event.type !== "activity") return;
      const key = `${event.activity.kind}:${event.activity.id}`;
      const result = reduceActivity(records.get(key), event.activity);
      assert(result.record);
      records.set(key, JSON.parse(JSON.stringify(result.record)));
    },
  );
  try {
    await adapter.start();
    await adapter.prompt("run commands");
    await wait(events, "completed");
    assert(!events.some((event) => event.type === "error"));
    for (const status of ["completed", "failed"])
      for (const replacement of ["empty", "image"])
        for (const combined of [false, true]) {
          const id = `output-${status}-${replacement}-${combined}`;
          const output = records.get(`output:${id}:output`);
          assert(output?.kind === "output");
          assert.equal(output.data.command, "gh pr create --fill");
          assert.equal(
            output.data.status,
            status === "completed" ? "exited" : "failed",
          );
          assert.equal(
            output.data.chunks.map((chunk) => chunk.text).join(""),
            "retained output",
          );
          const tool = records.get(`tool:${id}`);
          assert(tool?.kind === "tool");
          assert.equal(tool.data.status, status);
          assert.deepEqual(
            tool.data.content?.filter((entry) => entry.type === "output"),
            [{ type: "output", activity: `${id}:output` }],
          );
        }
  } finally {
    await adapter.dispose();
  }
});

test(
  "ACP disposal kills surviving tools after the harness leader exits",
  {
    skip: process.platform !== "linux",
    timeout: 12000,
  },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "loop-acp-orphan-"));
    const record = join(directory, "pids.json");
    const wrapper = join(directory, "wrapper.mjs");
    writeFileSync(
      wrapper,
      `
    import { spawn } from 'node:child_process';
    import { once } from 'node:events';
    import { writeFileSync } from 'node:fs';
    const tool = spawn(process.execPath, ['-e',
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.send('ready');"
    ], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    await once(tool, 'message');
    writeFileSync(${JSON.stringify(record)}, JSON.stringify({leader: process.pid, tool: tool.pid}));
    await import(${JSON.stringify(new URL("./fixtures/fake-acp.mjs", import.meta.url).href)});
  `,
    );
    const adapter = new Acp(
      {
        harness: "acp",
        executable: process.execPath,
        args: [wrapper],
        project: directory,
        billing: "existing",
        version: "fake",
      },
      () => {},
    );
    let leader: number | undefined;
    const until = async (condition: () => boolean) => {
      const deadline = Date.now() + 5000;
      while (!condition()) {
        assert(
          Date.now() < deadline,
          "process group did not reach expected state",
        );
        await delay(20);
      }
    };
    try {
      await adapter.start();
      const pids = JSON.parse(readFileSync(record, "utf8")) as {
        leader: number;
        tool: number;
      };
      leader = pids.leader;
      process.kill(leader, "SIGKILL");
      await until(() => !groupMembers(pids.leader).includes(pids.leader));
      assert(groupMembers(leader).includes(pids.tool));
      await adapter.dispose();
      await until(() => !groupAlive(pids.leader));
    } finally {
      if (leader && groupAlive(leader)) process.kill(-leader, "SIGKILL");
      await adapter.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
