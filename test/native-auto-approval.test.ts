import type { Live } from "../src/server/native-sessions";
import type { Request } from "../src/protocol";
import type { PermissionMode } from "../src/shared/permission-modes";
import { Claude } from "../src/adapters/claude";
import { Codex } from "../src/adapters/codex";
import { afterAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NativeOutput } from "../src/server/native-output";
import codexToolApproval from "./fixtures/codex-tool-approval.json" with { type: "json" };
import codexReviewApproval from "./fixtures/codex-review-approval.json" with { type: "json" };
const dir = mkdtempSync(join(tmpdir(), "loop-auto-approval-"));
process.env.LOOP_DATA_DIR = dir;
const { db } = await import("../src/server/db");
const { enqueue, claim } = await import("../src/server/queue");
const { NativeSessions, OWNER } = await import("../src/server/native-sessions");
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
const approval: Request = {
  id: "bash",
  kind: "approval",
  title: "Bash",
  detail: '{"input":{"command":"npm test"}}',
  choices: ["allow", "deny"],
  allow: "allow",
};

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
        expect(answer).toHaveBeenCalledExactlyOnceWith("102", {
          choice: "accept",
        });
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
    expect(answer).toHaveBeenCalledWith("bash", { choice: "allow" }),
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
  const { sessions, live, state, run } = session("async-question", "bypassPermissions");
  const adapter = new Codex({
    harness: "codex", executable: "", version: "fixture", project: dir, billing: "existing",
  }, (event) => sessions.event(live, event));
  live.adapter = adapter;
  const request = vi.fn().mockResolvedValue({ turn: { id: "continued", status: "inProgress" } });
  (adapter as any).native = { request };
  const frame = (method: string, params: unknown) => (adapter as any).message({ method, params });
  frame("turn/started", { turn: { id: "original" } });
  const item = {
    id: "call_async", type: "agentMessage", phase: "final_answer", delivery: "async",
    text: "Restart now or wait?", questions: [{ title: "Restart now or wait?", options: ["Wait", "Restart"] }],
  };
  frame("item/completed", { item });
  frame("item/completed", { item });
  frame("turn/completed", { turn: { id: "original", status: "completed" } });
  expect(state()).toBe("awaiting_approval");
  expect(request).not.toHaveBeenCalled();
  const decisions = db.prepare("SELECT id,state,request FROM native_decisions WHERE run_id=?").all(run.id) as any[];
  expect(decisions).toHaveLength(1);
  expect(decisions[0].state).toBe("pending");
  expect(JSON.parse(decisions[0].request).questions[0].options).toEqual(["Wait", "Restart"]);
  await sessions.answer(decisions[0].id, "answer-async", { "0": ["Wait"] });
  expect(request).toHaveBeenCalledWith("turn/start", expect.objectContaining({
    input: [expect.objectContaining({ text: 'Answers to your questions:\nRestart now or wait?\n["Wait"]' })],
  }));
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
    expect(bypass.answer).toHaveBeenCalledWith("bash", { choice: "allow" }),
  );
});
