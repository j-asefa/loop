import type { Live } from "../src/server/native-sessions";
import type { Request } from "../src/protocol";
import { ServerFrame } from "../src/protocol";
import { historicalEvent } from "../src/shared/workspace-events";
import type { PermissionMode } from "../src/shared/permission-modes";
import { Claude } from "../src/adapters/claude";
import { Codex } from "../src/adapters/codex";
import { NotDelivered } from "../src/adapters/types";
import { afterAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { NativeOutput } from "../src/server/native-output";
import {
  PERSONAL_DECISION_DETAIL_LIMIT,
  PERSONAL_DECISION_RESPONSE_LIMIT,
} from "../src/shared/personal-decisions";
import codexToolApproval from "./fixtures/codex-tool-approval.json" with { type: "json" };
import codexReviewApproval from "./fixtures/codex-review-approval.json" with { type: "json" };
const dir = mkdtempSync(join(tmpdir(), "loop-auto-approval-"));
process.env.LOOP_DATA_DIR = dir;
const { db } = await import("../src/server/db");
const { enqueue, claim } = await import("../src/server/queue");
const { NativeSessions, OWNER } = await import("../src/server/native-sessions");
const { personalDecisions } = await import("../src/server/personal-decisions");
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function session(
  name: string,
  permissionMode?: PermissionMode,
  harness: "claude" | "codex" = "claude",
) {
  db.prepare(
    "INSERT INTO conversations(id,owner_id,title,created_at) VALUES(?,?,'test',0)",
  ).run(name, OWNER);
  const queued = enqueue(OWNER, "test", name, { conversation: name });
  const run = claim("worker")!;
  expect(run.id).toBe(queued.id);
  const sessions = new NativeSessions();
  const Adapter = harness === "codex" ? Codex : Claude;
  const adapter = new Adapter(
    {
      harness,
      executable: resolve("test/harness.mjs"),
      version: "fixture",
      project: dir,
      billing: "existing",
    },
    (event) => {
      if (event.type === "request" || event.type === "resolved")
        sessions.event(live, event);
    },
  );
  const answer = vi.spyOn(adapter, "answer");
  if (harness === "claude") answer.mockResolvedValue();
  const live: Live = {
    run,
    binding: {
      conversation_id: name,
      harness,
      native_id: null,
      project: dir,
      model: null,
      instructions: "",
      generation: "test",
      state: "idle",
    },
    adapter,
    generation: "test",
    ready: Promise.resolve(),
    bootstrapRun: run,
    requests: new Map(),
    cancelling: false,
    waiting: false,
    bridgeWaiting: 0,
    items: new NativeOutput(),
    closed: false,
    permissionMode,
  };
  (sessions as any).live.set(name, live);
  const request = (request: Request) =>
    sessions.event(live, { type: "request", request });
  const state = () =>
    (db.prepare("SELECT state FROM runs WHERE id=?").get(run.id) as any).state;
  return { live, answer, request, state, run, sessions };
}
const dispatchGuard = expect.any(Function);
const approval: Request = {
  id: "bash",
  kind: "approval",
  title: "Bash",
  detail: '{"input":{"command":"npm test"}}',
  choices: ["allow", "deny"],
  allow: "allow",
};

it("stops rejected excess requests before publishing a native event", () => {
  const f = session("request-cap", "default");
  const interrupt = vi.spyOn(f.sessions, "interrupt").mockResolvedValue();
  for (let i = 0; i < 25; i++) f.request({ ...approval, id: "allowed-" + i });
  const decisions = () =>
    db
      .prepare("SELECT COUNT(*) AS count FROM native_decisions WHERE run_id=?")
      .get(f.run.id);
  const events = () =>
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM events WHERE run_id=? AND type='native.event'",
      )
      .get(f.run.id);
  expect(decisions()).toEqual({ count: 25 });
  expect(events()).toEqual({ count: 25 });
  f.request({ ...approval, id: "over-cap" });
  expect(interrupt).toHaveBeenCalledExactlyOnceWith(
    f.run.id,
    "Native decision exceeds safe display bounds.",
  );
  expect(f.live.requests.size).toBe(25);
  expect(decisions()).toEqual({ count: 25 });
  expect(events()).toEqual({ count: 25 });
  expect(f.answer).not.toHaveBeenCalled();
});

it.each([
  {
    name: "long-id-and-choices",
    request: {
      ...approval,
      id: "r".repeat(1001),
      choices: Array.from({ length: 1001 }, (_, i) => String(i)),
    },
  },
  {
    name: "many-questions-and-options",
    request: {
      id: "questions",
      kind: "question",
      title: "Choose",
      detail: "",
      questions: Array.from({ length: 1001 }, (_, i) => ({
        id: i === 0 ? "q".repeat(1001) : String(i),
        title: "Question",
        ...(i === 0
          ? { options: Array.from({ length: 1001 }, (_, n) => String(n)) }
          : {}),
      })),
    },
  },
  { name: "empty-native-id", request: { ...approval, id: "" } },
] satisfies { name: string; request: Request }[])(
  "preserves the existing bounded native request contract: $name",
  ({ name, request }) => {
    // These values are accepted by the existing protocol and fit ingress's
    // aggregate budget. Emission must not reject them after committing state.
    expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThan(64000);
    expect(() =>
      ServerFrame.parse({
        v: 1,
        epoch: "fixture",
        cursor: 1,
        event: { type: "request", request },
      }),
    ).not.toThrow();
    const f = session("native-limits-" + name, "default");
    expect(() => f.request(request)).not.toThrow();
    expect(f.state()).toBe("awaiting_approval");
    expect(f.answer).not.toHaveBeenCalled();
    const decision = db
      .prepare("SELECT state,request FROM native_decisions WHERE run_id=?")
      .get(f.run.id) as { state: string; request: string };
    expect(decision.state).toBe("pending");
    expect(JSON.parse(decision.request)).toEqual(request);

    expect(() =>
      f.sessions.event(f.live, { type: "resolved", id: request.id }),
    ).not.toThrow();
    expect(f.state()).toBe("running");
    expect(
      db
        .prepare("SELECT state FROM native_decisions WHERE run_id=?")
        .get(f.run.id),
    ).toEqual({ state: "resolved" });
    const rows = db
      .prepare(
        "SELECT run_id,type,payload FROM events WHERE run_id=? AND type='native.event' ORDER BY id",
      )
      .all(f.run.id) as { run_id: string; type: string; payload: string }[];
    expect(rows.map(historicalEvent)).toEqual([
      {
        type: "native.event",
        scope: { kind: "run", id: f.run.id },
        subject: { kind: "run", id: f.run.id },
        payload: {
          conversationId: f.live.binding.conversation_id,
          generation: "test",
          event: { type: "request", request },
        },
      },
      {
        type: "native.event",
        scope: { kind: "run", id: f.run.id },
        subject: { kind: "run", id: f.run.id },
        payload: {
          conversationId: f.live.binding.conversation_id,
          generation: "test",
          event: { type: "resolved", id: request.id },
        },
      },
    ]);
  },
);

function fileApproval(bytes = 100000) {
  const content = Buffer.alloc(bytes, 42).toString("base64");
  return {
    ...codexToolApproval,
    message:
      'Allow the loop_workspace MCP server to run tool "loop_publish_file"?',
    _meta: {
      codex_approval_kind: "mcp_tool_call",
      tool_params: { title: "preview.png", encoding: "base64", content },
      tool_params_display: [{ name: "content", value: content }],
    },
  };
}

it.each([
  ["default", "accept", 24000],
  ["default", "accept", 100000],
  ["default", "decline", 100000],
  ["default", "cancel", 100000],
  ["bypassPermissions", "accept", 100000],
] as const)(
  "large Codex file approvals preserve %s / %s decisions for %i bytes",
  async (mode, choice, bytes) => {
    const { live, answer, state, run, sessions } = session(
      `file-${mode}-${choice}-${bytes}`,
      mode,
      "codex",
    );
    const params = fileApproval(bytes);
    const original = structuredClone(params);
    const interrupt = vi.spyOn(sessions, "interrupt").mockResolvedValue();
    const decision = () =>
      db
        .prepare("SELECT id,state,request FROM native_decisions WHERE run_id=?")
        .get(run.id) as any;
    try {
      await live.adapter.start();
      await live.adapter.prompt(`mcp-${choice}\n` + JSON.stringify(params));
      await vi.waitFor(() => expect(decision()).toBeDefined());
      const stored = decision();
      expect(stored.request.length).toBeLessThan(64000);
      expect(stored.request).not.toContain(params._meta.tool_params.content);
      const detail = JSON.parse(JSON.parse(stored.request).detail);
      expect(detail._meta.tool_params.title).toBe("preview.png");
      expect(detail._meta.tool_params.encoding).toBe("base64");
      expect(detail._meta.tool_params.content).toContain(`${bytes} bytes`);
      expect(detail._meta.tool_params.content).toContain(
        createHash("sha256").update(Buffer.alloc(bytes, 42)).digest("hex"),
      );
      expect(detail._meta.tool_params_display[0].value).toBe(
        detail._meta.tool_params.content,
      );
      if (mode === "default") {
        expect(state()).toBe("awaiting_approval");
        expect(answer).not.toHaveBeenCalled();
        // The display summary must not replace the native call being approved.
        expect((live.adapter as any).requests.get("102").params).toMatchObject(
          original,
        );
        await sessions.answer(stored.id, "file-decision", { choice });
        await sessions.answer(stored.id, "file-decision", { choice });
      }
      await vi.waitFor(() => expect(decision().state).toBe("resolved"));
      expect(answer).toHaveBeenCalledExactlyOnceWith(
        "102",
        { choice },
        dispatchGuard,
      );
      expect(interrupt).not.toHaveBeenCalled();
      expect(state()).toBe("running");
    } finally {
      await live.adapter.dispose();
    }
  },
);

it("keeps oversized non-file decisions and unrecognized payloads subject to the size guard", () => {
  const { live, sessions, run } = session("file-guard", "default", "codex");
  const interrupt = vi.spyOn(sessions, "interrupt").mockResolvedValue();
  const original = fileApproval();
  const variants = [
    { ...original, serverName: "another_server" },
    { ...original, message: "Run another tool?" },
    { ...original, _meta: { ...original._meta, tool_name: "another_tool" } },
    {
      ...original,
      requestedSchema: {
        type: "object",
        properties: { answer: { type: "string" } },
      },
    },
    {
      ...original,
      _meta: {
        ...original._meta,
        tool_params: { ...original._meta.tool_params, encoding: "utf8" },
      },
    },
    {
      ...original,
      _meta: {
        ...original._meta,
        tool_params: {
          ...original._meta.tool_params,
          content: "!".repeat(70000),
        },
      },
    },
    {
      ...original,
      _meta: {
        ...original._meta,
        tool_params: {
          ...original._meta.tool_params,
          title: "x".repeat(70000),
        },
      },
    },
    {
      ...original,
      _meta: {
        ...original._meta,
        tool_params_display: [
          { name: "content", value: "different".repeat(10000) },
        ],
      },
    },
  ];
  for (const params of variants) {
    interrupt.mockClear();
    (live.adapter as any).message({
      id: 102,
      method: "mcpServer/elicitation/request",
      params,
    });
    expect(interrupt).toHaveBeenCalledOnce();
    expect(interrupt.mock.calls[0][0]).toBe(run.id);
    expect(live.requests.size).toBe(0);
  }
  expect(
    db.prepare("SELECT id FROM native_decisions WHERE run_id=?").all(run.id),
  ).toEqual([]);
});

it.each([
  ["council", codexToolApproval],
  ["review", codexReviewApproval],
] as const)(
  "Codex %s tool confirmations honor Never ask and retain manual approval otherwise",
  async (kind, params) => {
    for (const mode of ["bypassPermissions", "default"] as const) {
      const { live, answer, state, run, sessions } = session(
        "codex-" + kind + "-" + mode,
        mode,
        "codex",
      );
      try {
        await live.adapter.start();
        await live.adapter.prompt("mcp-accept\n" + JSON.stringify(params));
        const decision = () =>
          db
            .prepare(
              "SELECT id,state,request FROM native_decisions WHERE run_id=?",
            )
            .get(run.id) as any;
        await vi.waitFor(() => expect(decision()).toBeDefined());
        expect(JSON.parse(decision().request).allow).toBe("accept");
        if (mode === "default") {
          expect(state()).toBe("awaiting_approval");
          expect(answer).not.toHaveBeenCalled();
          await sessions.answer(decision().id, "manual-council-approval", {
            choice: "accept",
          });
        }
        await vi.waitFor(() => expect(decision().state).toBe("resolved"));
        expect(answer).toHaveBeenCalledExactlyOnceWith(
          "102",
          {
            choice: "accept",
          },
          dispatchGuard,
        );
        expect(state()).toBe("running");
      } finally {
        await live.adapter.dispose();
      }
    }
  },
);

it("Never ask answers a tool approval without waiting for the user", async () => {
  const { answer, request, state, run } = session(
    "bypass",
    "bypassPermissions",
  );
  request(approval);
  await vi.waitFor(() =>
    expect(answer).toHaveBeenCalledWith(
      "bash",
      { choice: "allow" },
      dispatchGuard,
    ),
  );
  expect(state()).toBe("running");
  await vi.waitFor(() =>
    expect(
      db
        .prepare("SELECT state FROM native_decisions WHERE run_id=?")
        .get(run.id),
    ).toEqual({ state: "resolved" }),
  );
});

it("Never ask still waits for questions and requests without an allow choice", () => {
  const { answer, request, state } = session("questions", "bypassPermissions");
  request({
    id: "question",
    kind: "question",
    title: "Which branch?",
    detail: "",
    questions: [{ id: "branch", title: "Which branch?" }],
  });
  request({
    id: "elicitation",
    kind: "approval",
    title: "MCP elicitation",
    detail: "",
    choices: ["decline", "cancel"],
  });
  expect(answer).not.toHaveBeenCalled();
  expect(state()).toBe("awaiting_approval");
});

it("Codex async questions persist as Needs you until the user answers, even after native completion", async () => {
  const { sessions, live, state, run } = session(
    "async-question",
    "bypassPermissions",
  );
  const adapter = new Codex(
    {
      harness: "codex",
      executable: "",
      version: "fixture",
      project: dir,
      billing: "existing",
    },
    (event) => sessions.event(live, event),
  );
  live.adapter = adapter;
  const request = vi
    .fn()
    .mockResolvedValue({ turn: { id: "continued", status: "inProgress" } });
  (adapter as any).native = { request };
  const frame = (method: string, params: unknown) =>
    (adapter as any).message({ method, params });
  frame("turn/started", { turn: { id: "original" } });
  const item = {
    id: "call_async",
    type: "agentMessage",
    phase: "final_answer",
    delivery: "async",
    text: "Restart now or wait?",
    questions: [
      { title: "Restart now or wait?", options: ["Wait", "Restart"] },
    ],
  };
  frame("item/completed", { item });
  frame("item/completed", { item });
  frame("turn/completed", { turn: { id: "original", status: "completed" } });
  expect(state()).toBe("awaiting_approval");
  expect(request).not.toHaveBeenCalled();
  const decisions = db
    .prepare("SELECT id,state,request FROM native_decisions WHERE run_id=?")
    .all(run.id) as any[];
  expect(decisions).toHaveLength(1);
  expect(decisions[0].state).toBe("pending");
  expect(JSON.parse(decisions[0].request).questions[0].options).toEqual([
    "Wait",
    "Restart",
  ]);
  await sessions.answer(decisions[0].id, "answer-async", { "0": ["Wait"] });
  expect(request).toHaveBeenCalledWith(
    "turn/start",
    expect.objectContaining({
      input: [
        expect.objectContaining({
          text: 'Answers to your questions:\nRestart now or wait?\n["Wait"]',
        }),
      ],
    }),
  );
  expect(state()).toBe("running");
  await sessions.answer(decisions[0].id, "answer-async", { "0": ["Wait"] });
  expect(request).toHaveBeenCalledTimes(1);
  clearTimeout(live.flush);
});

it("Ask every time leaves tool approvals for the user", () => {
  for (const mode of [undefined, "default", "acceptEdits"] as const) {
    const { answer, request, state } = session("ask-" + mode, mode);
    request(approval);
    expect(answer).not.toHaveBeenCalled();
    expect(state()).toBe("awaiting_approval");
  }
});

it("a session's own permission mode outranks the workspace level", async () => {
  const kept = session("session-plan", "bypassPermissions");
  db.prepare(
    "INSERT INTO companion_sessions(conversation_id,harness,project,updated_at,generation) VALUES(?,'claude',?,0,'test')",
  ).run("session-plan", dir);
  vi.spyOn(kept.live.adapter, "setSetting" as any).mockResolvedValue({
    options: [{ id: "mode", confirmed: "plan" }],
    revision: 1,
  });
  // Session settings switch this session to plan mode while the run is idle.
  const run = kept.live.run;
  kept.live.run = undefined;
  const sessions = new NativeSessions();
  (sessions as any).live.set("session-plan", kept.live);
  await sessions.setSetting("session-plan", "mode", "plan", 0, "test");
  expect(kept.live.sessionMode).toBe("plan");
  expect(
    db
      .prepare(
        "SELECT permission_mode FROM companion_sessions WHERE conversation_id=?",
      )
      .get("session-plan"),
  ).toEqual({ permission_mode: "plan" });
  clearTimeout(kept.live.idle);
  kept.live.run = run;
  sessions.event(kept.live, { type: "request", request: approval });
  expect(kept.answer).not.toHaveBeenCalled();
  // A session set to bypass is answered even when the workspace asks.
  const bypass = session("session-bypass", "default");
  bypass.live.sessionMode = "bypassPermissions";
  bypass.request(approval);
  await vi.waitFor(() =>
    expect(bypass.answer).toHaveBeenCalledWith(
      "bash",
      { choice: "allow" },
      dispatchGuard,
    ),
  );
});

function githubTreeApproval(size: number, character = "x") {
  const content = character.repeat(size);
  return {
    ...codexToolApproval,
    serverName: "codex_apps",
    message: 'Allow the GitHub MCP server to run tool "create_tree"?',
    _meta: {
      codex_approval_kind: "mcp_tool_call",
      tool_name: "github.create_tree",
      tool_title: "github.create_tree",
      tool_params: {
        owner: "fixture",
        repo: "fixture",
        tree: [
          { path: "src/example.ts", type: "blob", mode: "100644", content },
        ],
      },
      tool_params_display: [{ name: "content", value: content }],
    },
  };
}

it.each([
  ["bypassPermissions", undefined, 40000, "x", "accept"],
  ["bypassPermissions", undefined, 9 * 1024 * 1024, "x", "accept"],
  ["bypassPermissions", undefined, 10000, "😀", "accept"],
  ["default", "bypassPermissions", 300000, "x", "accept"],
  ["default", undefined, 9 * 1024 * 1024, "x", "accept"],
  ["default", undefined, 300000, "x", "decline"],
  ["default", undefined, 300000, "x", "cancel"],
  ["acceptEdits", undefined, 300000, "x", "accept"],
  ["bypassPermissions", "default", 300000, "x", "accept"],
] as const)(
  "large GitHub tool approvals honor %s / %s without changing the native call (%i %s / %s)",
  async (mode, sessionMode, size, character, choice) => {
    const { live, answer, state, run, sessions } = session(
      `large-tree-${mode}-${sessionMode}-${size}-${character}-${choice}`,
      mode,
      "codex",
    );
    live.sessionMode = sessionMode;
    const params = githubTreeApproval(size, character);
    const original = structuredClone(params);
    const interrupt = vi.spyOn(sessions, "interrupt").mockResolvedValue();
    const decision = () =>
      db
        .prepare("SELECT id,state,request FROM native_decisions WHERE run_id=?")
        .get(run.id) as any;
    // Exercise the real adapter response, checking its unmodified pending RPC.
    answer.mockImplementation(async (id, reply) => {
      const pending = (live.adapter as any).requests.get(id).params;
      expect(pending).toMatchObject(original);
      return Codex.prototype.answer.call(live.adapter, id, reply);
    });
    try {
      await live.adapter.start();
      await live.adapter.prompt(`mcp-${choice}\n` + JSON.stringify(params));
      await vi.waitFor(() => expect(decision()).toBeDefined());
      const stored = decision();
      expect(Buffer.byteLength(stored.request)).toBeLessThanOrEqual(64000);
      const request = JSON.parse(stored.request);
      expect(request.title).toBe("Allow github.create_tree?");
      const detail = JSON.parse(request.detail);
      const content = params._meta.tool_params.tree[0].content;
      expect(detail._meta.tool_params).toMatchObject({
        owner: "fixture",
        repo: "fixture",
        tree: [{ path: "src/example.ts", type: "blob", mode: "100644" }],
      });
      expect(detail._meta.tool_params.tree[0].content).toContain(
        `${Buffer.byteLength(content)} UTF-8 bytes`,
      );
      expect(detail._meta.tool_params.tree[0].content).toContain(
        createHash("sha256").update(content).digest("hex"),
      );
      expect(stored.request.includes(content)).toBe(false);
      expect(params).toEqual(original);
      if ((sessionMode ?? mode) !== "bypassPermissions") {
        expect(state()).toBe("awaiting_approval");
        expect(answer).not.toHaveBeenCalled();
        await sessions.answer(stored.id, "github-decision", { choice });
        await sessions.answer(stored.id, "github-decision", { choice });
      }
      await vi.waitFor(() => expect(decision()?.state).toBe("resolved"));
      expect(answer).toHaveBeenCalledExactlyOnceWith(
        "102",
        { choice },
        dispatchGuard,
      );
      expect(interrupt).not.toHaveBeenCalled();
      expect(state()).toBe("running");
    } finally {
      await live.adapter.dispose();
    }
  },
  15000,
);

it.each([
  "create_blob",
  "create_or_update_file",
  "create_or_update_file_contents",
  "push_files",
  "create_tree",
])(
  "keeps %s uploads reviewable with all non-content arguments and no duplicate payload",
  (tool) => {
    const { live, answer, state, run, sessions } = session(
      `github-shape-${tool}`,
      "default",
      "codex",
    );
    const interrupt = vi.spyOn(sessions, "interrupt").mockResolvedValue();
    const content = "😀".repeat(20000);
    const file = { path: "src/café.ts", content, mode: "100644", type: "blob" };
    const args = {
      owner: "fixture",
      repo: "destination",
      branch: "feature/topic",
      message: "Publish source files",
      ...(tool === "push_files"
        ? { files: [file, { path: "small.txt", content: "kept" }] }
        : tool === "create_tree"
          ? {
              base_tree: "existing-tree",
              tree: [
                file,
                {
                  path: "removed.txt",
                  sha: null,
                  type: "blob",
                  mode: "100644",
                },
              ],
            }
          : { ...file, encoding: "utf-8", sha: "existing-file" }),
    };
    const params = {
      ...githubTreeApproval(1),
      serverName: "github",
      _meta: {
        codex_approval_kind: "mcp_tool_call",
        tool_name: tool,
        tool_title: `github.${tool}`,
        tool_params: args,
        tool_params_display: [
          { name: "content", value: content },
          { name: "arguments", value: JSON.stringify(args, null, 2) },
        ],
      },
    };
    const original = structuredClone(params);
    (live.adapter as any).message({
      id: 102,
      method: "mcpServer/elicitation/request",
      params,
    });
    const stored = db
      .prepare("SELECT request FROM native_decisions WHERE run_id=?")
      .get(run.id) as any;
    expect(stored).toBeDefined();
    expect(Buffer.byteLength(stored.request)).toBeLessThan(64000);
    const preview = JSON.parse(JSON.parse(stored.request).detail)._meta
      .tool_params;
    const projectedFile =
      tool === "push_files"
        ? preview.files[0]
        : tool === "create_tree"
          ? preview.tree[0]
          : preview;
    expect(projectedFile.content).toContain(
      createHash("sha256").update(content).digest("hex"),
    );
    // Replacing only the projected bytes must reconstruct every original
    // argument, including deletions, destinations and small file contents.
    projectedFile.content = content;
    expect(preview).toEqual(args);
    expect(params).toEqual(original);
    expect((live.adapter as any).requests.get("102").params).toEqual(original);
    expect(answer).not.toHaveBeenCalled();
    expect(state()).toBe("awaiting_approval");
    expect(interrupt).not.toHaveBeenCalled();
  },
);

it.each(["bare-name", "generated-message"])(
  "summarizes a batch of small files with %s tool identification",
  (identity) => {
    const { live, answer, state, run, sessions } = session(
      `github-batch-${identity}`,
      "default",
      "codex",
    );
    const interrupt = vi.spyOn(sessions, "interrupt").mockResolvedValue();
    const params: any = githubTreeApproval(1);
    params._meta.tool_params.tree = Array.from({ length: 40 }, (_, i) => ({
      path: `src/file-${i}.ts`,
      mode: "100644",
      type: "blob",
      content: '\t\n"'.repeat(400),
    }));
    params._meta.tool_params_display = [
      { name: "tree", value: JSON.stringify(params._meta.tool_params.tree) },
    ];
    if (identity === "bare-name") params._meta.tool_name = "create_tree";
    else {
      delete params._meta.tool_name;
      delete params._meta.tool_title;
    }
    (live.adapter as any).message({
      id: 102,
      method: "mcpServer/elicitation/request",
      params,
    });
    const stored = db
      .prepare("SELECT request FROM native_decisions WHERE run_id=?")
      .get(run.id) as any;
    expect(stored).toBeDefined();
    expect(Buffer.byteLength(stored.request)).toBeLessThan(64000);
    const tree = JSON.parse(JSON.parse(stored.request).detail)._meta.tool_params
      .tree;
    expect(tree).toHaveLength(40);
    expect(
      tree.every(
        (file: any, i: number) =>
          file.path === `src/file-${i}.ts` && file.content.includes("SHA-256"),
      ),
    ).toBe(true);
    expect(state()).toBe("awaiting_approval");
    expect(answer).not.toHaveBeenCalled();
    expect(interrupt).not.toHaveBeenCalled();
  },
);

it("does not shorten other oversized decisions or forms requiring user input", () => {
  const original = githubTreeApproval(300000);
  const cases = [
    {
      name: "unknown-tool",
      mode: "default" as const,
      sessionMode: undefined,
      params: {
        ...original,
        _meta: { ...original._meta, tool_name: "github.some_other_action" },
      },
    },
    {
      name: "large-commit-message",
      mode: "default" as const,
      sessionMode: undefined,
      params: {
        ...original,
        _meta: {
          ...original._meta,
          tool_params: {
            ...original._meta.tool_params,
            message: "x".repeat(300000),
          },
        },
      },
    },
    {
      name: "real-form-tree",
      mode: "bypassPermissions" as const,
      sessionMode: undefined,
      params: {
        ...original,
        requestedSchema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
        },
      },
    },
  ];
  for (const item of cases) {
    const { live, answer, run, sessions } = session(
      item.name,
      item.mode,
      "codex",
    );
    live.sessionMode = item.sessionMode;
    const interrupt = vi.spyOn(sessions, "interrupt").mockResolvedValue();
    (live.adapter as any).message({
      id: 102,
      method: "mcpServer/elicitation/request",
      params: item.params,
    });
    expect(answer).not.toHaveBeenCalled();
    expect(interrupt).toHaveBeenCalledWith(
      run.id,
      "Native decision exceeds safe display bounds.",
    );
    expect(live.requests.size).toBe(0);
    expect(
      db.prepare("SELECT id FROM native_decisions WHERE run_id=?").all(run.id),
    ).toEqual([]);
  }
  const question = session("large-question", "bypassPermissions");
  const interrupt = vi
    .spyOn(question.sessions, "interrupt")
    .mockResolvedValue();
  question.request({
    id: "question",
    kind: "question",
    title: "Choose",
    detail: "x".repeat(300000),
    questions: [{ id: "branch", title: "Which branch?" }],
  });
  expect(question.answer).not.toHaveBeenCalled();
  expect(interrupt).toHaveBeenCalledWith(
    question.run.id,
    "Native decision exceeds safe display bounds.",
  );
});

it("does not retry an uncertain automatic answer after abbreviating a large request", async () => {
  const { answer, request, run, state, sessions } = session(
    "large-uncertain",
    "bypassPermissions",
  );
  const interrupt = vi.spyOn(sessions, "interrupt").mockResolvedValue();
  answer.mockRejectedValue(
    new Error("Fixture transport disconnected after sending"),
  );
  const oversized = { ...approval, detail: "x".repeat(300000) };
  const decision = () =>
    db
      .prepare("SELECT id,state FROM native_decisions WHERE run_id=?")
      .get(run.id) as any;
  request(oversized);
  await vi.waitFor(() => expect(decision()?.state).toBe("unknown"));
  request(oversized);
  await expect(
    sessions.answer(decision().id, "auto:" + decision().id, {
      choice: "allow",
    }),
  ).resolves.toEqual({ state: "unknown" });
  await expect(
    sessions.answer(decision().id, "retry", { choice: "allow" }),
  ).rejects.toThrow();
  expect(answer).toHaveBeenCalledExactlyOnceWith(
    "bash",
    { choice: "allow" },
    dispatchGuard,
  );
  expect(decision().state).toBe("unknown");
  expect(state()).toBe("awaiting_approval");
  expect(interrupt).not.toHaveBeenCalled();
});

it("keeps a confirmed answer resolved when the transport subsequently fails", async () => {
  const { live, answer, request, run, sessions } = session(
    "confirmed-transport-failure",
    "default",
  );
  request(approval);
  const decision = db
    .prepare("SELECT id FROM native_decisions WHERE run_id=?")
    .get(run.id) as { id: string };
  answer.mockImplementation(async () => {
    sessions.event(live, { type: "resolved", id: approval.id });
    throw new Error("transport closed after confirmation");
  });
  await expect(
    sessions.answer(decision.id, "confirmed-command", { choice: "allow" }),
  ).resolves.toEqual({ state: "resolved" });
  await expect(
    sessions.answer(decision.id, "confirmed-command", { choice: "allow" }),
  ).resolves.toEqual({ state: "resolved" });
  expect(answer).toHaveBeenCalledExactlyOnceWith(
    approval.id,
    {
      choice: "allow",
    },
    dispatchGuard,
  );
  expect(
    db
      .prepare("SELECT state FROM native_decisions WHERE id=?")
      .get(decision.id),
  ).toEqual({ state: "resolved" });
  expect(
    personalDecisions(OWNER, { kind: "approval" }).items.filter(
      (item) => item.id === "native:" + decision.id,
    ),
  ).toMatchObject([
    { state: "resolved", choice: "allow", response_recorded: true },
  ]);
});

it("records validated native answers once, hides secrets, and retains uncertain delivery without replay", async () => {
  const f = session("personal-answers", "default");
  f.request({
    id: "questions",
    kind: "question",
    title: "Deployment preferences",
    detail: "Choose how to ship " + "x".repeat(20_000),
    questions: [
      { id: "target", title: "Which environment?", multiple: true },
      { id: "token", title: "Access token", secret: true },
    ],
  });
  const decision = db
    .prepare("SELECT id FROM native_decisions WHERE run_id=?")
    .get(f.run.id) as { id: string };
  const response = {
    target: ["Staging", "Canary"],
    token: ["secret-token-value"],
    extra: ["unsolicited-secret"],
  };
  await expect(
    f.sessions.answer(decision.id, "bad-answer", {
      target: "wrong",
      token: [],
    }),
  ).rejects.toThrow("Invalid question answer");
  expect(
    db
      .prepare("SELECT 1 FROM personal_decisions WHERE native_decision_id=?")
      .get(decision.id),
  ).toBeUndefined();
  f.answer.mockRejectedValue(new Error("Lost acknowledgement"));
  await expect(
    f.sessions.answer(decision.id, "personal-answer", response),
  ).rejects.toThrow("unknown");
  await expect(
    f.sessions.answer(decision.id, "personal-answer", response),
  ).resolves.toEqual({ state: "unknown" });
  expect(f.answer).toHaveBeenCalledExactlyOnceWith(
    "questions",
    response,
    dispatchGuard,
  );
  const item = personalDecisions(OWNER, { kind: "answer" }).items.find(
    (item) => item.id === "native:" + decision.id,
  );
  expect(item).toMatchObject({
    title: "Deployment preferences",
    state: "unknown",
    conversation_id: "personal-answers",
    detail_truncated: true,
    answers: [
      {
        question: "Which environment?",
        values: ["Staging", "Canary"],
        secret: false,
      },
      { question: "Access token", values: null, secret: true },
    ],
  });
  expect(Buffer.byteLength(JSON.stringify(item?.detail))).toBeLessThanOrEqual(
    PERSONAL_DECISION_DETAIL_LIMIT,
  );
  const persisted = db
    .prepare(
      "SELECT response FROM personal_decisions WHERE native_decision_id=?",
    )
    .get(decision.id);
  expect(JSON.stringify(persisted)).not.toContain("secret-token-value");
  expect(JSON.stringify(persisted)).not.toContain("unsolicited-secret");
  expect(JSON.stringify(item)).not.toContain("secret-token-value");
  expect(personalDecisions("other-owner", { kind: "answer" }).items).toEqual(
    [],
  );
});

it("bounds saved answer previews without changing the complete answer delivered to the harness", async () => {
  const f = session("large-personal-answer", "default");
  const questions: NonNullable<Request["questions"]> = [
    { id: "token", title: "Access token", secret: true },
    ...Array.from({ length: 49 }, (_, i) => ({
      id: "q" + i,
      title: "Question " + i,
    })),
  ];
  f.request({
    id: "large-questions",
    kind: "question",
    title: "Large answers",
    detail: "",
    questions,
  });
  const decision = db
    .prepare("SELECT id FROM native_decisions WHERE run_id=?")
    .get(f.run.id) as { id: string };
  const response = Object.fromEntries(
    questions.map((q) => [
      q.id,
      q.secret
        ? ["private-answer"]
        : Array.from({ length: 30 }, (_, i) =>
            i === 0 ? "🙂\\\u0001".repeat(1000) : "x".repeat(8000),
          ),
    ]),
  );
  await f.sessions.answer(decision.id, "large-answer-command", response);
  await f.sessions.answer(decision.id, "large-answer-command", response);
  expect(f.answer).toHaveBeenCalledExactlyOnceWith(
    "large-questions",
    response,
    dispatchGuard,
  );
  expect(response.q48[29]).toHaveLength(8000);
  const stored = db
    .prepare(
      "SELECT response,response_truncated FROM personal_decisions WHERE native_decision_id=?",
    )
    .get(decision.id) as { response: string; response_truncated: number };
  expect(Buffer.byteLength(stored.response)).toBeLessThanOrEqual(
    PERSONAL_DECISION_RESPONSE_LIMIT,
  );
  expect(stored.response_truncated).toBe(1);
  expect(stored.response).not.toContain("private-answer");
  const item = personalDecisions(OWNER, { kind: "answer" }).items.find(
    (item) => item.id === "native:" + decision.id,
  )!;
  expect(item.response_recorded).toBe(true);
  expect(item.response_truncated).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(item.answers))).toBeLessThanOrEqual(
    PERSONAL_DECISION_RESPONSE_LIMIT,
  );
  expect(item.answers[0]).toMatchObject({ secret: true, values: null });
  expect(item.answers[1].values?.[0]).toMatch(/^🙂/);
  expect(item.answers[1].values?.[0]).toMatch(/…$/);
  expect(item.answers.some((answer) => answer.values?.length === 0)).toBe(
    false,
  );
});

it("leaves automatic native approvals and externally resolved questions out of personal history", async () => {
  const automatic = session("personal-auto", "bypassPermissions");
  automatic.request(approval);
  await vi.waitFor(() => expect(automatic.answer).toHaveBeenCalledOnce());
  expect(
    db
      .prepare("SELECT 1 FROM personal_decisions WHERE run_id=?")
      .get(automatic.run.id),
  ).toBeUndefined();
  const external = session("personal-external", "default");
  external.request({
    id: "external-question",
    kind: "question",
    title: "Choose",
    detail: "",
    questions: [{ id: "q", title: "Which?" }],
  });
  external.sessions.event(external.live, {
    type: "resolved",
    id: "external-question",
  });
  expect(
    db
      .prepare("SELECT 1 FROM personal_decisions WHERE run_id=?")
      .get(external.run.id),
  ).toBeUndefined();
});

it("reopens a decision the harness explicitly refused, and keeps other failures uncertain", async () => {
  const f = session("refused-answer", "default");
  f.answer.mockRejectedValueOnce(
    new NotDelivered("Muse Code did not accept this decision."),
  );
  f.request(approval);
  const decision = db
    .prepare("SELECT id FROM native_decisions WHERE run_id=?")
    .get(f.run.id) as { id: string };
  await expect(
    f.sessions.answer(decision.id, "11111111-1111-4111-8111-111111111111", {
      choice: "allow",
    }),
  ).rejects.toThrow(/did not accept this decision\. Answer again/);
  expect(
    db
      .prepare("SELECT state,command_id FROM native_decisions WHERE id=?")
      .get(decision.id),
  ).toEqual({ state: "pending", command_id: null });
  expect(
    personalDecisions(OWNER, { kind: "approval" }).items.find(
      (item) => item.id === "native:" + decision.id,
    ),
  ).toBeUndefined();
  expect(
    await f.sessions.answer(
      decision.id,
      "22222222-2222-4222-8222-222222222222",
      { choice: "allow" },
    ),
  ).toEqual({ state: "resolved" });
  expect(f.answer).toHaveBeenCalledTimes(2);
  expect(
    personalDecisions(OWNER, { kind: "approval" }).items.filter(
      (item) => item.id === "native:" + decision.id,
    ),
  ).toMatchObject([{ choice: "allow", state: "resolved" }]);

  const g = session("uncertain-answer", "default");
  g.answer.mockRejectedValueOnce(new Error("transport closed"));
  g.request(approval);
  const uncertain = db
    .prepare("SELECT id FROM native_decisions WHERE run_id=?")
    .get(g.run.id) as { id: string };
  await expect(
    g.sessions.answer(uncertain.id, "33333333-3333-4333-8333-333333333333", {
      choice: "allow",
    }),
  ).rejects.toThrow(/outcome is unknown/);
  expect(
    db
      .prepare("SELECT state FROM native_decisions WHERE id=?")
      .get(uncertain.id),
  ).toEqual({ state: "unknown" });
  expect(
    personalDecisions(OWNER, { kind: "approval" }).items.find(
      (item) => item.id === "native:" + uncertain.id,
    ),
  ).toMatchObject({ choice: "allow", state: "unknown" });
});

it("expires a refused decision when its run ended while the answer was in flight", async () => {
  const f = session("refused-after-end", "default");
  f.request(approval);
  f.answer.mockImplementationOnce(async () => {
    db.prepare("UPDATE runs SET state='completed' WHERE id=?").run(f.run.id);
    throw new NotDelivered("Muse Code did not accept this decision.");
  });
  const decision = db
    .prepare("SELECT id FROM native_decisions WHERE run_id=?")
    .get(f.run.id) as { id: string };
  await expect(
    f.sessions.answer(decision.id, "44444444-4444-4444-8444-444444444444", {
      choice: "allow",
    }),
  ).rejects.toThrow(/expired or was already handled/);
  expect(
    db
      .prepare("SELECT state FROM native_decisions WHERE id=?")
      .get(decision.id),
  ).toEqual({ state: "expired" });
  expect(
    personalDecisions(OWNER, { kind: "approval" }).items.find(
      (item) => item.id === "native:" + decision.id,
    ),
  ).toBeUndefined();
});

it("reports a refused decision as resolved when the harness resolved it meanwhile", async () => {
  const f = session("refused-after-resolution", "default");
  f.request(approval);
  f.answer.mockImplementationOnce(async () => {
    f.sessions.event(f.live, { type: "resolved", id: approval.id });
    throw new NotDelivered("Muse Code did not accept this decision.");
  });
  const decision = db
    .prepare("SELECT id FROM native_decisions WHERE run_id=?")
    .get(f.run.id) as { id: string };
  expect(
    await f.sessions.answer(
      decision.id,
      "55555555-5555-4555-8555-555555555555",
      { choice: "allow" },
    ),
  ).toEqual({ state: "resolved" });
  expect(
    db
      .prepare("SELECT state FROM native_decisions WHERE id=?")
      .get(decision.id),
  ).toEqual({ state: "resolved" });
  expect(
    personalDecisions(OWNER, { kind: "approval" }).items.find(
      (item) => item.id === "native:" + decision.id,
    ),
  ).toMatchObject({ choice: "allow", state: "resolved" });
});
