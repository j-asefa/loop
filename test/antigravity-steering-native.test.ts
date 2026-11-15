import { PublicConnection } from "../src/shared/workspace-contract-schemas.js";
import { afterAll, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gitProject } from "./git-project";
import { until } from "./helpers";

const dir = mkdtempSync(join(tmpdir(), "loop-antigravity-native-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_TEST_AGY_LOG = join(dir, "requests");
gitProject(dir);
const { db } = await import("../src/server/db");
const { NativeSessions } = await import("../src/server/native-sessions");
const { OWNER } = await import("../src/server/workspace-identity");
const { createAgent, ownedConnection, ownedRun } =
  await import("../src/server/domain");
const { enqueue, claim } = await import("../src/server/queue");
const { eligibleMailAgent } = await import("../src/server/agent-mail-policy");
const { createTeam } = await import("../src/server/teams");
const { harnessName } = await import("../src/client/modelChoices");
const { activeRun, saveSteering } = await import("../src/server/steering");
const sessions = new NativeSessions();
afterAll(async () => {
  await sessions.close();
  db.close();
  for (const name of [
    "LOOP_TEST_AGY_LOG",
    "LOOP_TEST_AGY_MODE",
    "LOOP_TEST_AGY_SESSION_ID",
    "LOOP_TEST_AGY_SLOW_STOP",
  ])
    delete process.env[name];
  rmSync(dir, { recursive: true, force: true });
});
const requests = () =>
  readFileSync(process.env.LOOP_TEST_AGY_LOG!, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
const prompts = () =>
  requests()
    .filter((r) => r.acp === "session/prompt")
    .map((r) => r.params.prompt[0].text);

it.each([
  ["signed-out", "native_auth_missing", "Antigravity is not signed in"],
  ["auth-failure", "antigravity_setup_failed", "run agy"],
])(
  "returns safe, actionable %s guidance from runtime enable without registering or sending a prompt",
  async (mode, code, message) => {
    process.env.LOOP_TEST_AGY_MODE = mode;
    try {
      await expect(
        sessions.projects.enable({
          harness: "antigravity",
          executable: resolve("test/fixtures/fake-antigravity-steering.mjs"),
          version: "1.5.2",
          project: dir,
          billing: "existing",
        }),
      ).rejects.toMatchObject({
        status: 422,
        message: expect.stringContaining(message),
        diagnostic: {
          phase: "native startup",
          code,
          promptSent: false,
        },
      });
      expect(() => ownedConnection("native-antigravity", OWNER)).toThrow();
      expect(
        requests().every((request) => request.args?.[0] === "models"),
      ).toBe(true);
    } finally {
      delete process.env.LOOP_TEST_AGY_MODE;
    }
  },
);
function task(key: string, text = "Explicit task") {
  process.env.LOOP_TEST_AGY_SESSION_ID = key;
  const agent = createAgent(OWNER, {
    name: key,
    connectionId: "native-antigravity",
    model: "native-default",
    instructions: "Saved fixture instructions",
  });
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,'Antigravity',0)",
  ).run(key, OWNER, agent.id);
  const run = enqueue(OWNER, text, key, {
    conversation: key,
    agent: agent.id,
    payload: {
      agentId: agent.id,
      name: agent.name,
      provider: "antigravity",
      folderId: null,
      connectionId: "native-antigravity",
      model: "native-default",
      instructions: agent.instructions,
    },
  });
  return { agent, run };
}

it("registers Antigravity with honest capabilities and owner isolation", async () => {
  const registration = await sessions.projects.enable({
    harness: "antigravity",
    executable: resolve("test/fixtures/fake-antigravity-steering.mjs"),
    version: "1.5.2",
    project: dir,
    billing: "existing",
  });
  expect(registration.models).toContainEqual({
    id: "gemini-agy-fixture",
    name: "Gemini fixture",
  });
  const connection = ownedConnection("native-antigravity", OWNER);
  expect(connection).toMatchObject({
    provider: "antigravity",
    secret: "",
    status: "connected",
    owner_id: OWNER,
  });
  expect(connection.metadata).toMatchObject({
    loopHarness: "antigravity",
    authMode: "native-existing",
    capabilities: {
      billingVerified: false,
      approvals: true,
      questions: false,
    },
  });
  expect(() => ownedConnection(connection.id, "other-owner")).toThrow();
  expect(
    harnessName(
      PublicConnection.parse({
        ...connection,
        metadata: JSON.stringify(connection.metadata),
        models: JSON.stringify(connection.models),
      }),
    ),
  ).toBe("Antigravity");
  const { agent } = task("agy-capabilities");
  expect(() => eligibleMailAgent(OWNER, agent.id)).toThrow(/workspace tools/);
  expect(() => eligibleMailAgent("other-owner", agent.id)).toThrow(/not found/);
  const worker = task("agy-team-worker").agent;
  expect(() =>
    createTeam(OWNER, {
      name: "Unsupported team",
      managerId: agent.id,
      members: [worker.id],
    }),
  ).toThrow(/workspace tools/);
});

it("resumes only its saved native ID under a new generation without replaying tasks", async () => {
  const { run } = task("agy-resume");
  const first = await sessions.session(run);
  expect(first.binding.native_id).toBe("agy-resume");
  const project = first.binding.project;
  expect(project).not.toBe(dir);
  const generation = first.generation;
  await sessions.dispose(first);
  const resumed = await sessions.session(run);
  expect(resumed.binding.native_id).toBe("agy-resume");
  expect(resumed.binding.project).toBe(project);
  expect(resumed.generation).not.toBe(generation);
  expect(() =>
    sessions.current(run.conversation_id!, generation, false),
  ).toThrow(/not active/);
  expect(prompts()).toEqual([]);
  expect(
    requests()
      .filter((r) => r.acp === "session/resume")
      .map((r) => r.params.sessionId),
  ).toEqual(["agy-resume"]);
  expect(requests().some((r) => r.acp === "session/load")).toBe(false);
  await sessions.dispose(resumed);
});

it("an explicit Grok-to-Antigravity switch retains the agent workspace and starts fresh native context", async () => {
  await sessions.projects.enable({
    harness: "grok",
    executable: resolve("test/fixtures/fake-grok.mjs"),
    version: "1.0.70",
    project: dir,
    billing: "existing",
  });
  const { run } = task("agy-switch");
  const legacy = await sessions.session({
    ...run,
    payload: {
      ...run.payload,
      connectionId: "native-grok",
      provider: "grok",
      model: "grok-fixture",
    },
  });
  const project = legacy.binding.project;
  expect(legacy.binding.native_id).toBe("grok-session");
  await sessions.dispose(legacy);
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES('legacy-message',?,?,'user','Earlier Grok task',0)",
  ).run(OWNER, run.conversation_id);
  const switched = await sessions.session(run);
  expect(switched.binding.harness).toBe("antigravity");
  expect(switched.binding.project).toBe(project);
  expect(switched.binding.native_id).toBe("agy-switch");
  expect(switched.binding.instructions).toContain("Earlier Grok task");
  expect(
    requests().some(
      (r) => r.acp === "session/resume" && r.params.sessionId === "agy-switch",
    ),
  ).toBe(false);
  expect(prompts()).toHaveLength(0);
  expect(ownedConnection("native-grok", OWNER).provider).toBe("grok");
  await sessions.dispose(switched);
});

it.each(["disconnect", "error"])(
  "production dispatch never replays an uncertain Antigravity %s",
  async (mode) => {
    process.env.LOOP_TEST_AGY_MODE = mode;
    const { run } = task("agy-uncertain-" + mode.toLowerCase());
    const claimed = claim(
      "antigravity-fixture",
      (candidate) => candidate.id === run.id,
    )!;
    expect(claimed?.id).toBe(run.id);
    const before = prompts().length;
    expect(await sessions.execute(claimed)).not.toMatchObject({
      kind: "finished",
    });
    expect(ownedRun(run.id, OWNER).state).toBe("failed");
    const receipt = db
      .prepare(
        "SELECT generation,digest,state FROM native_dispatch WHERE run_id=?",
      )
      .get(run.id);
    expect(receipt).toBeTruthy();
    expect(prompts()).toHaveLength(before + 1);
    await expect(sessions.execute(run)).rejects.toThrow(
      /already dispatched|uncertain outcome/,
    );
    sessions.recover();
    await expect(new NativeSessions().execute(run)).rejects.toThrow(
      /already dispatched|uncertain outcome/,
    );
    expect(
      db
        .prepare(
          "SELECT generation,digest,state FROM native_dispatch WHERE run_id=?",
        )
        .get(run.id),
    ).toEqual(receipt);
    expect(prompts()).toHaveLength(before + 1);
    delete process.env.LOOP_TEST_AGY_MODE;
  },
);

it.each(["cancel", "cancelled", "max_tokens", "error"])(
  "an immediate explicit follow-up after %s continues the same conversation without replaying the task",
  async (mode) => {
    process.env.LOOP_TEST_AGY_MODE = mode === "cancel" ? "hang" : mode;
    process.env.LOOP_TEST_AGY_SLOW_STOP = "1";
    const { run } = task("agy-after-" + mode.replace("_", "-"));
    const claimed = claim(
      "antigravity-fixture",
      (candidate) => candidate.id === run.id,
    )!;
    const before = prompts().length;
    const execution = sessions.execute(claimed);
    await until(() => prompts().length === before + 1);
    if (mode === "cancel") await sessions.interrupt(run.id);
    expect(await execution).toMatchObject({
      kind: "already-moved",
      reason: mode === "error" ? "native-failed" : "native-interrupted",
    });
    expect(ownedRun(run.id, OWNER).state).toBe(
      mode === "error" ? "failed" : "interrupted",
    );
    const originalPid = requests()
      .filter((r) => r.args?.[0] === "acp")
      .at(-1).pid;
    const original = db
      .prepare(
        "SELECT generation,native_id FROM companion_sessions WHERE conversation_id=?",
      )
      .get(run.conversation_id) as { generation: string; native_id: string };
    const receipt = db
      .prepare("SELECT * FROM native_dispatch WHERE run_id=?")
      .get(run.id);
    // An interrupted ACP turn leaves agy's session usable, so the live
    // session is kept; a failed turn ends it and the next turn resumes.
    const live = (() => {
      try {
        sessions.current(run.conversation_id!, original.generation, false);
        return true;
      } catch {
        return false;
      }
    })();
    expect(live).toBe(mode !== "error");
    const launched = requests().filter((r) => r.args?.[0] === "acp").length;
    delete process.env.LOOP_TEST_AGY_MODE;
    delete process.env.LOOP_TEST_AGY_SLOW_STOP;
    const next = enqueue(OWNER, "Explicit follow-up", run.id + "-follow-up", {
      conversation: run.conversation_id!,
      agent: run.agent_id!,
      payload: run.payload,
    });
    expect(
      await sessions.execute(
        claim("antigravity-fixture", (candidate) => candidate.id === next.id)!,
      ),
    ).toMatchObject({ kind: "finished" });
    const log = requests();
    const resumed = db
      .prepare(
        "SELECT generation,native_id FROM companion_sessions WHERE conversation_id=?",
      )
      .get(run.conversation_id) as { generation: string; native_id: string };
    expect(resumed.native_id).toBe(original.native_id);
    if (live) {
      expect(resumed.generation).toBe(original.generation);
      expect(log.filter((r) => r.args?.[0] === "acp")).toHaveLength(launched);
    } else {
      // The failed process exits before the conversation resumes.
      const exited = log.findIndex(
        (r) => r.event === "fixture-exit" && r.pid === originalPid,
      );
      const started = log.findIndex(
        (r) =>
          r.acp === "session/resume" &&
          r.params.sessionId === run.conversation_id,
      );
      expect(exited).toBeGreaterThan(-1);
      expect(started).toBeGreaterThan(exited);
      expect(() => process.kill(originalPid, 0)).toThrow();
      expect(resumed.generation).not.toBe(original.generation);
    }
    expect(prompts().slice(before)).toEqual([
      "Saved fixture instructions\n\nExplicit task",
      "Saved fixture instructions\n\nExplicit follow-up",
    ]);
    expect(
      db.prepare("SELECT * FROM native_dispatch WHERE run_id=?").get(run.id),
    ).toEqual(receipt);
    await expect(sessions.execute(run)).rejects.toThrow(
      /already dispatched|uncertain outcome/,
    );
    await sessions.dispose(
      sessions.current(run.conversation_id!, resumed.generation, false),
    );
  },
);

it("steers a running turn through agy acp without a restart or replaying the task", async () => {
  const { run } = task("agy-steer", "[slow] Write an essay");
  const claimed = claim(
    "antigravity-fixture",
    (candidate) => candidate.id === run.id,
  )!;
  const before = prompts().length;
  const launches = () => requests().filter((r) => r.args?.[0] === "acp");
  // With workspace tools configured, a user reply would ask for loop_reply;
  // Antigravity receives no workspace tools, so it must not.
  sessions.tools = () => ({ url: "http://127.0.0.1:9/mcp", token: "unused" });
  const execution = sessions.execute(claimed);
  await until(() => prompts().length === before + 1);
  const launched = launches().length;
  // A reply to the running turn steers it rather than queueing.
  expect(activeRun(OWNER, run.conversation_id!)?.liveInput).toBe(true);
  saveSteering(
    ownedRun(run.id, OWNER),
    "agy-steer-key",
    "agy-steer-request",
    "Change course",
    {},
  );
  expect(await execution).toMatchObject({ kind: "finished" });
  sessions.tools = undefined;
  // The steered turn did not end early; the worker completes the run.
  expect(ownedRun(run.id, OWNER).state).toBe("running");
  expect(
    db.prepare("SELECT state FROM run_steering WHERE run_id=?").all(run.id),
  ).toEqual([{ state: "delivered" }]);
  expect(launches()).toHaveLength(launched);
  expect(prompts().slice(before)).toEqual([
    "Saved fixture instructions\n\n[slow] Write an essay",
    "Change course",
  ]);
});

it("replaces an idle ACP session after refreshing workspace-tool support while retaining native context", async () => {
  const { run } = task("agy-acp-upgrade");
  const before = await sessions.session(run);
  expect(before.adapter.capabilities.workspaceTools).toBe(false);
  await sessions.projects.enable({
    harness: "antigravity",
    executable: resolve("test/fixtures/fake-antigravity.mjs"),
    version: "1.5.9",
    project: dir,
    billing: "existing",
  });
  expect(before.closed).toBe(false);
  const after = await sessions.session(run);
  expect(after.generation).not.toBe(before.generation);
  expect(before.closed).toBe(true);
  expect(after.binding.native_id).toBe(before.binding.native_id);
  expect(after.binding.project).toBe(before.binding.project);
  expect(after.adapter.capabilities.workspaceTools).toBe(true);
  await sessions.dispose(after);
});
