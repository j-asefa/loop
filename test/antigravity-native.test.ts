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
const { NativeSessions, nativeSessions } =
  await import("../src/server/native-sessions");
const { OWNER } = await import("../src/server/workspace-identity");
const { createAgent, ownedConnection, ownedRun } =
  await import("../src/server/domain");
const { enqueue, claim, transition } = await import("../src/server/queue");
const { eligibleMailAgent } = await import("../src/server/agent-mail-policy");
const { createTeam, deleteTeam } = await import("../src/server/teams");
const { submit } = await import("../src/server/agent-runtime");
const { activeRun } = await import("../src/server/steering");
const { harnessName } = await import("../src/client/modelChoices");
const sessions = nativeSessions;
const { NativeToolBridge } = await import("../src/server/native-tool-bridge");
const bridge = new NativeToolBridge();
await bridge.start();
let ticket: { url: string; token: string };
sessions.tools = (conversation, generation) =>
  (ticket = bridge.issue(conversation, generation));
sessions.revokeTools = (conversation, generation) =>
  bridge.revoke(conversation, generation);
afterAll(async () => {
  await sessions.close();
  await bridge.close();
  db.close();
  for (const name of [
    "LOOP_TEST_AGY_LOG",
    "LOOP_TEST_AGY_MODE",
    "LOOP_TEST_AGY_SESSION_ID",
    "LOOP_TEST_AGY_SLOW_STOP",
    "LOOP_TEST_AGY_RECIPIENT",
  ])
    delete process.env[name];
  rmSync(dir, { recursive: true, force: true });
});
const requests = () =>
  readFileSync(process.env.LOOP_TEST_AGY_LOG!, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

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
          executable: resolve("test/fixtures/fake-antigravity.mjs"),
          version: "1.4.9",
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
function task(key: string) {
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
  const run = enqueue(OWNER, "Explicit task", key, {
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
    executable: resolve("test/fixtures/fake-antigravity.mjs"),
    version: "1.4.9",
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
      approvals: false,
      questions: false,
      workspaceTools: false,
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
  expect(requests().filter((r) => r.event === "user")).toEqual([]);
  const args = requests().at(-1).args;
  expect(
    args.slice(
      args.indexOf("--conversation"),
      args.indexOf("--conversation") + 2,
    ),
  ).toEqual(["--conversation", "agy-resume"]);
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
  expect(requests().at(-1).args).not.toContain("--conversation");
  expect(requests().filter((r) => r.event === "user")).toHaveLength(0);
  expect(ownedConnection("native-grok", OWNER).provider).toBe("grok");
  await sessions.dispose(switched);
});

it.each(["disconnect", "WAITING"])(
  "production dispatch never replays an uncertain Antigravity %s",
  async (mode) => {
    process.env.LOOP_TEST_AGY_MODE = mode;
    const { run } = task("agy-uncertain-" + mode.toLowerCase());
    const claimed = claim(
      "antigravity-fixture",
      (candidate) => candidate.id === run.id,
    )!;
    expect(claimed?.id).toBe(run.id);
    const before = requests().filter((r) => r.event === "user").length;
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
    expect(requests().filter((r) => r.event === "user")).toHaveLength(
      before + 1,
    );
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
    expect(requests().filter((r) => r.event === "user")).toHaveLength(
      before + 1,
    );
    delete process.env.LOOP_TEST_AGY_MODE;
  },
);

it.each(["cancel", "CANCELED", "INTERRUPTED", "WAITING"])(
  "an immediate explicit follow-up after %s waits for shutdown and resumes without replaying the task",
  async (mode) => {
    process.env.LOOP_TEST_AGY_MODE = mode === "cancel" ? "hang" : mode;
    process.env.LOOP_TEST_AGY_SLOW_STOP = "1";
    const { run } = task("agy-after-" + mode.toLowerCase());
    const claimed = claim(
      "antigravity-fixture",
      (candidate) => candidate.id === run.id,
    )!;
    const before = requests().filter((r) => r.event === "user").length;
    const execution = sessions.execute(claimed);
    await until(
      () => requests().filter((r) => r.event === "user").length === before + 1,
    );
    if (mode === "cancel") await sessions.interrupt(run.id);
    expect(await execution).toMatchObject({
      kind: "already-moved",
      reason: mode === "WAITING" ? "native-failed" : "native-interrupted",
    });
    expect(ownedRun(run.id, OWNER).state).toBe(
      mode === "WAITING" ? "failed" : "interrupted",
    );
    const originalPid = requests()
      .filter((r) => r.args?.includes("stream-json"))
      .at(-1).pid;
    const original = db
      .prepare(
        "SELECT generation,native_id FROM companion_sessions WHERE conversation_id=?",
      )
      .get(run.conversation_id) as { generation: string; native_id: string };
    const receipt = db
      .prepare("SELECT * FROM native_dispatch WHERE run_id=?")
      .get(run.id);
    expect(() =>
      sessions.current(run.conversation_id!, original.generation, false),
    ).toThrow(/not active/);
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
    const exited = log.findIndex(
      (r) => r.event === "fixture-exit" && r.pid === originalPid,
    );
    const started = log.findIndex((r) => r.args?.includes(run.conversation_id));
    expect(exited).toBeGreaterThan(-1);
    expect(started).toBeGreaterThan(exited);
    expect(() => process.kill(originalPid, 0)).toThrow();
    const resumed = db
      .prepare(
        "SELECT generation,native_id FROM companion_sessions WHERE conversation_id=?",
      )
      .get(run.conversation_id) as { generation: string; native_id: string };
    expect(resumed.native_id).toBe(original.native_id);
    expect(resumed.generation).not.toBe(original.generation);
    expect(
      requests()
        .filter((r) => r.event === "user")
        .slice(before)
        .map((r) => r.message.content),
    ).toEqual([
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

for (const refresh of [false, true]) {
  it(`queues replies to a running legacy session${refresh ? " after runtime refresh" : ""}`, async () => {
    await sessions.projects.enable({
      harness: "antigravity",
      executable: resolve("test/fixtures/fake-antigravity.mjs"),
      version: "1.4.9",
      project: dir,
      billing: "existing",
    });
    process.env.LOOP_TEST_AGY_MODE = "hang";
    const { run, agent } = task(refresh ? "agy-old-refresh" : "agy-old-reply");
    const current = claim("old-reply", (candidate) => candidate.id === run.id)!;
    const before = requests().filter((r) => r.event === "user").length;
    const execution = sessions.execute(current);
    let queued: ReturnType<typeof submit> | undefined;
    try {
      await until(
        () =>
          requests().filter((r) => r.event === "user").length === before + 1,
      );
      if (refresh)
        await sessions.projects.enable({
          harness: "antigravity",
          executable: resolve("test/fixtures/fake-antigravity.mjs"),
          version: "1.5.9",
          project: dir,
          billing: "existing",
        });
      if (refresh) {
        await expect(sessions.session(current)).rejects.toMatchObject({
          status: 409,
        });
        expect(ownedRun(run.id, OWNER).state).toBe("running");
        expect(requests().filter((r) => r.event === "user")).toHaveLength(
          before + 1,
        );
      }
      expect(activeRun(OWNER, run.conversation_id!)?.liveInput).toBe(false);
      expect(activeRun("other-owner", run.conversation_id!)).toBeUndefined();
      queued = submit(OWNER, {
        agentId: agent.id,
        conversationId: run.conversation_id!,
        input: "Next turn",
        idempotencyKey: run.id + "-reply",
        steer: true,
      });
      expect(queued).not.toHaveProperty("steeringId");
      expect(queued.state).toBe("queued");
      expect(queued.id).not.toBe(run.id);
      expect(queued.conversation_id).toBe(run.conversation_id);
      expect(
        db.prepare("SELECT id FROM run_steering WHERE run_id=?").all(run.id),
      ).toEqual([]);
    } finally {
      await sessions.interrupt(run.id);
      await execution;
      if (queued) transition(queued, "cancelled");
      delete process.env.LOOP_TEST_AGY_MODE;
      await sessions.projects.enable({
        harness: "antigravity",
        executable: resolve("test/fixtures/fake-antigravity.mjs"),
        version: "1.4.9",
        project: dir,
        billing: "existing",
      });
    }
  });
}

it("refuses an ACP runtime without HTTP MCP support before registering or dispatching a prompt", async () => {
  process.env.LOOP_TEST_AGY_MODE = "no-http";
  const before = requests().filter((r) => r.method === "session/prompt").length;
  try {
    await expect(
      sessions.projects.enable({
        harness: "antigravity",
        executable: resolve("test/fixtures/fake-antigravity.mjs"),
        version: "1.5.9",
        project: dir,
        billing: "existing",
      }),
    ).rejects.toThrow(/HTTP workspace tools/);
    expect(
      requests().filter((r) => r.method === "session/prompt"),
    ).toHaveLength(before);
    expect(
      ownedConnection("native-antigravity", OWNER).metadata.capabilities
        ?.workspaceTools,
    ).toBe(false);
  } finally {
    delete process.env.LOOP_TEST_AGY_MODE;
  }
});

it("injects generation-scoped workspace tools into ACP and sends mail once through the production bridge", async () => {
  const legacy = task("agy-upgrade-history");
  const saved = await sessions.session(legacy.run);
  const savedProject = saved.binding.project;
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES('agy-released-answer',?,?,'assistant','Saved historical answer',0)",
  ).run(OWNER, legacy.run.conversation_id);
  await sessions.projects.enable({
    harness: "antigravity",
    executable: resolve("test/fixtures/fake-antigravity.mjs"),
    version: "1.5.9",
    project: dir,
    billing: "existing",
  });
  expect(
    ownedConnection("native-antigravity", OWNER).metadata.capabilities,
  ).toMatchObject({ workspaceTools: true, approvals: true });
  expect(saved.closed).toBe(false);
  const upgraded = await sessions.session(legacy.run);
  expect(upgraded.generation).not.toBe(saved.generation);
  expect(saved.closed).toBe(true);
  expect(upgraded.binding.native_id).toBe("agy-upgrade-history");
  expect(upgraded.binding.project).toBe(savedProject);
  expect(upgraded.adapter.activityTransport).toBe("acp");
  expect(
    db
      .prepare("SELECT content FROM messages WHERE id='agy-released-answer'")
      .get(),
  ).toEqual({ content: "Saved historical answer" });
  await sessions.dispose(upgraded);
  const { agent, run } = task("agy-acp-mail");
  expect(eligibleMailAgent(OWNER, agent.id).id).toBe(agent.id);
  expect(() => eligibleMailAgent("other-owner", agent.id)).toThrow(/not found/);
  db.prepare(
    `INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES('mail-api',?,'openai','Fixture','','connected','[{"id":"fixture"}]','{}',0)`,
  ).run(OWNER);
  const recipient = createAgent(OWNER, {
    name: "mail-recipient",
    connectionId: "mail-api",
    model: "fixture",
  });
  const team = createTeam(OWNER, {
    name: "ACP tools team",
    managerId: agent.id,
    members: [recipient.id],
  });
  expect(team.manager_id).toBe(agent.id);
  deleteTeam(OWNER, team.id);
  process.env.LOOP_TEST_AGY_RECIPIENT = recipient.id;
  const active = claim("agy-mail", (candidate) => candidate.id === run.id)!;
  try {
    expect(await sessions.execute(active)).toEqual({ kind: "finished" });
    const activities = db
      .prepare("SELECT record FROM agent_activities WHERE conversation_id=?")
      .all(run.conversation_id) as { record: string }[];
    expect(activities.length).toBeGreaterThan(0);
    expect(
      activities.every(
        (row) => JSON.parse(row.record).source.transport === "acp",
      ),
    ).toBe(true);
    expect(requests().findLast((r) => r.event === "catalog").tools).toEqual(
      expect.arrayContaining(["loop_agents", "loop_message", "loop_handoff"]),
    );
    const mails = db
      .prepare(
        "SELECT sender_agent_id,recipient_agent_id,run_id FROM agent_mail WHERE sender_agent_id=?",
      )
      .all(agent.id) as { run_id: string }[];
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({
      sender_agent_id: agent.id,
      recipient_agent_id: recipient.id,
    });
    expect(ownedRun(mails[0].run_id, OWNER).state).toBe("queued");
    expect(requests().findLast((r) => r.event === "duplicate-mail").same).toBe(
      true,
    );
    const old = { ...ticket };
    const request = {
      method: "tools/call",
      id: "late",
      name: "loop_message",
      arguments: { to: recipient.id, body: "late" },
    };
    const call = (token: string) =>
      fetch(old.url + "/pi", {
        method: "POST",
        headers: { authorization: "Bearer " + token },
        body: JSON.stringify(request),
      });
    expect((await call("wrong-token")).status).toBe(403);
    expect((await call(old.token)).status).toBe(409);
    const live = sessions.current(
      run.conversation_id!,
      (await sessions.session(run)).generation,
      false,
    );
    const generation = live.generation;
    await sessions.dispose(live);
    const resumed = await sessions.session(run);
    expect(resumed.binding.native_id).toBe("agy-acp-mail");
    expect(resumed.generation).not.toBe(generation);
    expect((await call(old.token)).status).toBe(403);
    expect(
      requests().findLast((r) => r.method === "session/resume").params
        .sessionId,
    ).toBe("agy-acp-mail");
    expect(
      requests().filter((r) => r.method === "session/prompt"),
    ).toHaveLength(1);
    await sessions.dispose(resumed);
  } finally {
    delete process.env.LOOP_TEST_AGY_RECIPIENT;
  }
});

it("never resends an ACP prompt after a disconnect, including through recovery", async () => {
  process.env.LOOP_TEST_AGY_MODE = "disconnect";
  const { run } = task("agy-acp-uncertain");
  const before = requests().filter((r) => r.method === "session/prompt").length;
  try {
    expect(
      await sessions.execute(
        claim("agy-mail", (candidate) => candidate.id === run.id)!,
      ),
    ).toMatchObject({ kind: "already-moved", reason: "native-failed" });
    const receipt = db
      .prepare("SELECT * FROM native_dispatch WHERE run_id=?")
      .get(run.id);
    expect(receipt).toBeTruthy();
    sessions.recover();
    await expect(sessions.execute(run)).rejects.toThrow(
      /already dispatched|uncertain outcome/,
    );
    expect(
      requests().filter((r) => r.method === "session/prompt"),
    ).toHaveLength(before + 1);
    expect(
      db.prepare("SELECT * FROM native_dispatch WHERE run_id=?").get(run.id),
    ).toEqual(receipt);
  } finally {
    delete process.env.LOOP_TEST_AGY_MODE;
  }
});

it.each(["delayed-commands", "early-commands"])(
  "loads %s through the production catalog probe and cache without prompting",
  async (mode) => {
    process.env.LOOP_TEST_AGY_MODE = mode;
    sessions.projects.clearProbes();
    const beforeProbe = requests().filter(
      (r) => r.method === "session/new",
    ).length;
    const { agent } = task(`agy-catalog-${mode}`);
    const beforePrompts = requests().filter(
      (r) => r.method === "session/prompt",
    ).length;
    try {
      const catalog = await sessions.projects.catalog(agent);
      expect(catalog.commands).toContainEqual({
        name: "plan",
        token: "/plan",
        kind: "command",
        description: "Plan before executing.",
      });
      const afterProbe = requests().filter(
        (r) => r.method === "session/new",
      ).length;
      expect(afterProbe).toBe(beforeProbe + 1);
      expect(await sessions.projects.catalog(agent)).toEqual(catalog);
      expect(requests().filter((r) => r.method === "session/new")).toHaveLength(
        afterProbe,
      );
      expect(
        requests().filter((r) => r.method === "session/prompt"),
      ).toHaveLength(beforePrompts);
    } finally {
      delete process.env.LOOP_TEST_AGY_MODE;
    }
  },
);
