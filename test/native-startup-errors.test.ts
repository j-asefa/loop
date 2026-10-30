import { gitProject } from "./git-project.js";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { Native, NativeRpcError, NativeTransportError } from "../src/native";
import { NativeMemoryError } from "../src/native-memory";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "loop55-native-startup-")));
process.env.LOOP55_PROFILE = "companion";
process.env.LOOP55_DATA_DIR = dir;
gitProject(dir);
const { db } = await import("../src/server/db");
db.prepare(
  "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,created_at) VALUES('worktree-fixture','local-workspace','Fixture','fixture','codex','fixture',0)",
).run();
const { enqueue } = await import("../src/server/queue");
const { tick, execute } = await import("../src/server/worker");
const { nativeSessions } = await import("../src/server/native-sessions");
const executable = resolve("test/harness.mjs");
chmodSync(executable, 0o755);
const options = {
  harness: "pi",
  executable,
  project: dir,
  billing: "subscription",
  version: "fixture",
};
db.prepare("INSERT INTO harnesses VALUES('pi',?,'{}','{}','[]',0)").run(
  JSON.stringify(options),
);
db.prepare(
  "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES('native-pi','local-workspace','pi','Pi','','connected','[]',?,0)",
).run(JSON.stringify({ loop55Harness: "pi" }));

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.LOOP55_TEST_HARNESS;
  delete process.env.LOOP55_TEST_PI_AUTH;
  delete process.env.LOOP55_TEST_AUDIT;
});

it.each([
  [
    "memory",
    new NativeMemoryError(5 * 1024 ** 3, true),
    "Out of memory.",
    "native_memory_limit",
  ],
  [
    "timeout",
    new NativeTransportError(
      "native_request_timeout",
      "private transport context",
      { method: "thread/start", timeoutMs: 30000 },
    ),
    "did not respond within 30 seconds",
    "native_request_timeout",
  ],
  [
    "exit",
    new NativeTransportError("native_process_exit", "private process context", {
      signal: "SIGKILL",
      exitCode: null,
    }),
    "exited during startup (SIGKILL)",
    "native_process_exit",
  ],
  [
    "rejected",
    new NativeRpcError(
      "secret-provider-token private-file.txt",
      -32004,
      undefined,
      "thread/start",
    ),
    "rejected the request",
    "native_startup_rejected",
  ],
  [
    "unknown",
    new Error("secret-provider-token private-file.txt"),
    "more specific startup cause",
    "native_startup_failed",
  ],
])(
  "preserves actionable %s startup failures through the real worker without dispatch or raw diagnostics",
  async (name, error, expected, code) => {
    process.env.LOOP55_TEST_HARNESS = "codex";
    const audit = join(dir, `startup-${name}.log`);
    process.env.LOOP55_TEST_AUDIT = audit;
    db.prepare(
      "INSERT OR REPLACE INTO harnesses VALUES('codex',?,'{}','{}','[]',0)",
    ).run(
      JSON.stringify({ ...options, harness: "codex", billing: "existing" }),
    );
    db.prepare(
      "INSERT OR IGNORE INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES('native-codex','local-workspace','codex','Codex','','connected','[]','{\"loop55Harness\":\"codex\"}',0)",
    ).run();
    const conversation = `startup-${name}`;
    db.prepare(
      "INSERT INTO conversations(id,owner_id,title,created_at) VALUES(?,'local-workspace','Setup test',0)",
    ).run(conversation);
    const request = Native.prototype.request;
    vi.spyOn(Native.prototype, "request").mockImplementation(function (
      this: Native,
      method,
      params,
      rpc,
    ) {
      return method === "thread/start"
        ? Promise.reject(error)
        : request.call(this, method, params, rpc);
    });
    const run = enqueue(
      "local-workspace",
      "Do not dispatch this",
      conversation,
      {
        conversation,
        agent: "worktree-fixture",
        payload: {
          agentId: "worktree-fixture",
          name: "Fixture",
          provider: "codex",
          connectionId: "native-codex",
          model: "fixture",
          instructions: "",
          folderId: null,
        },
      },
    );
    expect(await tick(execute)).toBe(true);
    const result = db
      .prepare("SELECT state,error FROM runs WHERE id=?")
      .get(run.id) as any;
    expect(result.state).toBe("failed");
    expect(result.error).toContain(expected);
    expect(result.error).toContain("No prompt was sent.");
    expect(result.error).not.toMatch(
      /private|secret-provider-token|Open failure details/,
    );
    const trace = db
      .prepare(
        "SELECT content,metadata FROM run_traces WHERE run_id=? AND trace_key='run:failure'",
      )
      .get(run.id) as any;
    expect(trace.content).toBe(result.error);
    expect(JSON.parse(trace.metadata).failure).toMatchObject({
      phase: "native startup",
      code,
      promptSent: false,
    });
    expect(trace.metadata).not.toMatch(/private|secret-provider-token/);
    expect(
      db.prepare("SELECT 1 FROM native_dispatch WHERE run_id=?").get(run.id),
    ).toBeUndefined();
    expect(existsSync(audit)).toBe(false);
  },
);
it("persists a running agent's confirmed memory failure for cards without replaying the turn", async () => {
  process.env.LOOP55_TEST_HARNESS = "codex";
  const conversation = "running-memory";
  db.prepare(
    "INSERT INTO conversations(id,owner_id,title,created_at) VALUES(?,'local-workspace','Memory test',0)",
  ).run(conversation);
  const request = Native.prototype.request;
  let prompts = 0;
  vi.spyOn(Native.prototype, "request").mockImplementation(function (
    this: Native,
    method,
    params,
    rpc,
  ) {
    if (method !== "turn/start") return request.call(this, method, params, rpc);
    prompts++;
    setImmediate(() =>
      this.emit("failure", new NativeMemoryError(5 * 1024 ** 3, true)),
    );
    return Promise.resolve({ turn: { id: "memory-turn" } });
  });
  const run = enqueue("local-workspace", "wait", conversation, {
    conversation,
    agent: "worktree-fixture",
    payload: {
      agentId: "worktree-fixture",
      name: "Fixture",
      provider: "codex",
      connectionId: "native-codex",
      model: "fixture",
      instructions: "",
      folderId: null,
    },
  });
  expect(await tick(execute)).toBe(true);
  expect(
    db.prepare("SELECT state,error FROM runs WHERE id=?").get(run.id),
  ).toEqual({
    state: "failed",
    error: new NativeMemoryError(5 * 1024 ** 3, true).message,
  });
  expect(
    db.prepare("SELECT state FROM native_dispatch WHERE run_id=?").get(run.id),
  ).toEqual({ state: "failed" });
  expect(prompts).toBe(1);
});

afterAll(async () => {
  await nativeSessions.close();
  db.close();
  delete process.env.LOOP55_PROFILE;
  rmSync(dir, { recursive: true, force: true });
});

it("preserves safe subscription setup guidance through the real worker and trace boundary without dispatch", async () => {
  process.env.LOOP55_TEST_HARNESS = "pi";
  process.env.LOOP55_TEST_PI_AUTH = "api";
  const audit = join(dir, "prompts.log");
  process.env.LOOP55_TEST_AUDIT = audit;
  db.prepare(
    "INSERT INTO conversations(id,owner_id,title,created_at) VALUES('startup','local-workspace','Setup test',0)",
  ).run();
  const run = enqueue(
    "local-workspace",
    "What folders can you access?",
    "startup",
    {
      conversation: "startup",
      agent: "worktree-fixture",
      payload: {
        agentId: "worktree-fixture",
        name: "Fixture",
        provider: "pi",
        folderId: null,
        connectionId: "native-pi",
        model: "openai/fixture",
        instructions: "",
      },
    },
  );
  expect(await tick(execute)).toBe(true);
  const result = db
    .prepare("SELECT state,error FROM runs WHERE id=?")
    .get(run.id) as any;
  expect(result.state).toBe("failed");
  expect(result.error).toContain("subscription login");
  expect(result.error).toContain("openai-codex");
  expect(result.error).toContain(
    "No prompt was sent and no API fallback occurred",
  );
  const trace = db
    .prepare(
      "SELECT content,metadata FROM run_traces WHERE run_id=? AND trace_key='run:failure'",
    )
    .get(run.id) as any;
  expect(trace.content).toBe(result.error);
  expect(JSON.parse(trace.metadata).failure).toMatchObject({
    phase: "native startup",
    code: "native_billing_mismatch",
  });
  expect(
    db
      .prepare(
        "SELECT state FROM companion_sessions WHERE conversation_id='startup'",
      )
      .get(),
  ).toEqual({ state: "failed" });
  expect(
    db.prepare("SELECT 1 FROM native_dispatch WHERE run_id=?").get(run.id),
  ).toBeUndefined();
  expect(existsSync(audit)).toBe(false);
});

it("also returns safe setup guidance when enabling Pi", async () => {
  process.env.LOOP55_TEST_HARNESS = "pi";
  process.env.LOOP55_TEST_PI_AUTH = "api";
  await expect(nativeSessions.enable(options as any)).rejects.toMatchObject({
    status: 422,
    diagnostic: { phase: "native startup", code: "native_billing_mismatch" },
  });
});
