import type { Live } from "../src/server/native-sessions";
import type { Request } from "../src/protocol";
import type { PermissionMode } from "../src/shared/permission-modes";
import { Claude } from "../src/adapters/claude";
import { afterAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeOutput } from "../src/server/native-output";
const dir = mkdtempSync(join(tmpdir(), "loop-auto-approval-"));
process.env.LOOP_DATA_DIR = dir;
const { db } = await import("../src/server/db");
const { enqueue, claim } = await import("../src/server/queue");
const { NativeSessions, OWNER } = await import("../src/server/native-sessions");
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function session(name: string, permissionMode?: PermissionMode) {
  db.prepare(
    "INSERT INTO conversations(id,owner_id,title,created_at) VALUES(?,?,'test',0)",
  ).run(name, OWNER);
  const queued = enqueue(OWNER, "test", name, { conversation: name });
  const run = claim("worker")!;
  expect(run.id).toBe(queued.id);
  const sessions = new NativeSessions();
  const adapter = new Claude(
    {
      harness: "claude",
      executable: "",
      version: "fixture",
      project: dir,
      billing: "existing",
    },
    () => {},
  );
  const answer = vi.spyOn(adapter, "answer").mockResolvedValue();
  const live: Live = {
    run,
    binding: {
      conversation_id: name,
      harness: "claude",
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
  return { live, answer, request, state, run };
}
const approval: Request = {
  id: "bash",
  kind: "approval",
  title: "Bash",
  detail: '{"input":{"command":"npm test"}}',
  choices: ["allow", "deny"],
  allow: "allow",
};

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
  expect(db.prepare("SELECT permission_mode FROM companion_sessions WHERE conversation_id=?").get("session-plan")).toEqual({ permission_mode: "plan" });
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
