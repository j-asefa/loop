import { afterAll, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetAuthority } from "../src/server/fleet-authority.js";
import { Codex } from "../src/adapters/codex.js";
import { Claude } from "../src/adapters/claude.js";
import { NotDelivered } from "../src/adapters/types.js";
import type { DirectControls } from "../src/adapters/direct-controls.js";
import type { Setting } from "../src/agent-activities.js";
import express from "express";
import { FleetWorkspaceApp } from "../src/server/fleet-workspace-app.js";
import { NativeOutput } from "../src/server/native-output.js";
import type { Live } from "../src/server/native/state.js";
import type { Run } from "../src/server/queue.js";
import { gitProject } from "./git-project.js";
import { fleetActor } from "./fleet-action-fixture.js";

const root = mkdtempSync(join(tmpdir(), "loop-fleet-propagation-"));
process.env.LOOP_PROFILE = "companion";
process.env.LOOP_DATA_DIR = root;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db } = await import("../src/server/db.js");
const secrets = await import("../src/server/secrets.js");
const { createAgent, ownedRun } = await import("../src/server/domain.js");
const { submit, executeAgent } = await import("../src/server/agent-runtime.js");
const { withTestAdapter } = await import("../src/server/providers.js");
const { invokeNative, nativeBindings } =
  await import("../src/server/native-tools.js");
const { createTeam, createPresetTeam } = await import("../src/server/teams.js");
const { SteeringInbox } = await import("../src/server/steering.js");
const { editQueuedRun } =
  await import("../src/server/mobile-return/queued-runs.js");
const { authorizeFleetEffect } =
  await import("../src/server/fleet-effect-authorizations.js");
const { sendMail, sweepAgentMail } =
  await import("../src/server/agent-mail.js");
const { startWorkflow, executeWorkflow } =
  await import("../src/server/workflows/runtime.js");
const { compile } = await import("../src/server/workflows/compiler.js");
const { requestReview } = await import("../src/server/code-reviews.js");
const { NativeDecisions } = await import("../src/server/native/decisions.js");
const { core } = await import("../src/server/core-routes.js");
const { mountRoutes } = await import("../src/server/registrar.js");
const owner = "local-workspace",
  account = randomUUID();
const authority = new FleetAuthority(db, secrets);
authority.create(owner, {
  mutationId: randomUUID(),
  name: "Fixture",
  origin: "https://local.example",
  scope: ["read", "act"],
});
db.prepare(
  "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,?,'openai','Fixture',?,'connected',?,0)",
).run(
  account,
  owner,
  secrets.seal("fixture", owner),
  JSON.stringify([{ id: "fixture" }]),
);

function peer() {
  return fleetActor(owner, authority, secrets, authorizeFleetEffect);
}
function stored(sql: string, ...params: unknown[]) {
  return db.prepare(sql).get(...params);
}
function agent() {
  return createAgent(owner, {
    name: "propagation-" + randomUUID().slice(0, 8),
    connectionId: account,
    model: "fixture",
  });
}
function start(
  agentId = agent().id,
  options: Partial<Parameters<typeof submit>[1]> = {},
) {
  return submit(owner, {
    agentId,
    input: "Fixture work",
    idempotencyKey: randomUUID(),
    ...options,
  });
}
function running(run: Run) {
  db.prepare("UPDATE runs SET state='running' WHERE id=?").run(run.id);
  return ownedRun(run.id, owner);
}
function nativeAdapter(
  harness: "codex" | "claude",
  billing: "existing" | "subscription" = "existing",
) {
  const Adapter = harness === "codex" ? Codex : Claude;
  return new Adapter(
    {
      harness,
      executable: process.execPath,
      project: root,
      version: "fixture",
      billing,
    },
    () => {},
  );
}
function nativeLive(
  run: Run,
  adapter: Live["adapter"],
  harness: Live["binding"]["harness"],
  generation: string,
  overrides: Partial<Live> = {},
): Live {
  return {
    adapter,
    generation,
    binding: {
      conversation_id: run.conversation_id!,
      harness,
      project: root,
      native_id: null,
      model: null,
      instructions: "",
      generation,
      state: "idle",
    },
    ready: Promise.resolve(),
    bootstrapRun: run,
    items: new NativeOutput(),
    requests: new Map(),
    closed: false,
    cancelling: false,
    waiting: false,
    bridgeWaiting: 0,
    ...overrides,
  };
}
const retryApp = express();
retryApp.use(express.json());
retryApp.use((_req, res, next) => {
  res.locals.owner = owner;
  next();
});
mountRoutes(retryApp, core, "/api");
retryApp.use(((error, _req, res, _next) => {
  res.status(error.status ?? 500).json({ error: error.message });
}) as express.ErrorRequestHandler);
const retryBridge = new FleetWorkspaceApp(retryApp, owner);
function retry(run: Run, key = randomUUID()) {
  return retryBridge.action(
    owner,
    {
      route: "runAction",
      params: { id: run.id, action: "retry" },
      body: { idempotencyKey: key },
    },
    () => {},
  );
}
function failed(run: Run) {
  db.prepare("UPDATE runs SET state='failed' WHERE id=?").run(run.id);
  return ownedRun(run.id, owner);
}
async function blocked(run: Run) {
  run = running(run);
  let providerCalls = 0;
  const restore = withTestAdapter("openai", {
    async models() {
      return [];
    },
    async *stream() {
      providerCalls++;
      yield { text: "Unexpected dispatch" };
    },
  });
  try {
    await expect(executeAgent(run)).rejects.toMatchObject({ status: 403 });
    expect(providerCalls).toBe(0);
    const binding = nativeBindings(run).find(
      (tool) => tool.tool === "loop_diagram",
    );
    if (binding)
      await expect(
        invokeNative(run, binding, randomUUID(), {
          title: "Denied effect",
          source: "graph LR; A-->B",
        }),
      ).rejects.toMatchObject({ status: 403 });
    expect(
      stored(
        "SELECT count(*) n FROM artifacts WHERE run_id=? AND kind='diagram'",
        run.id,
      ),
    ).toEqual({ n: 0 });
  } finally {
    restore();
  }
}
afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

it.each([
  ["creator", "local"],
  ["creator", "peer"],
  ["editor", "local"],
  ["editor", "peer"],
] as const)("a %s constraint survives a %s retry", async (source, caller) => {
  const creator = peer(),
    editor = peer(),
    requester = peer();
  const original = creator.act(() => start());
  editor.act(() => editQueuedRun(owner, original.id, { input: "Edited work" }));
  failed(original);
  const response = await (caller === "peer"
    ? requester.act(() => retry(original))
    : retry(original));
  const replacement = ownedRun((response.result as { id: string }).id, owner);
  expect(replacement.input).toBe("Edited work");
  (source === "creator" ? creator : editor).revoke();
  await blocked(replacement);
});

it("a retry refuses revoked source work without accepting a replacement", async () => {
  const creator = peer(),
    requester = peer();
  const original = failed(creator.act(() => start()));
  creator.revoke();
  const key = randomUUID();
  await expect(requester.act(() => retry(original, key))).rejects.toMatchObject(
    { status: 403 },
  );
  expect(
    stored("SELECT id FROM runs WHERE idempotency_key=?", key),
  ).toBeUndefined();
});

it("retry acceptance rolls back if its inherited authorization cannot be stored", async () => {
  const creator = peer();
  const original = failed(creator.act(() => start()));
  const key = randomUUID();
  db.exec(
    "CREATE TEMP TRIGGER reject_retry_authorization BEFORE INSERT ON fleet_effect_edit_authorizations BEGIN SELECT RAISE(ABORT, 'fixture inheritance failure'); END",
  );
  try {
    await expect(retry(original, key)).rejects.toMatchObject({ status: 502 });
    expect(
      stored("SELECT id FROM runs WHERE idempotency_key=?", key),
    ).toBeUndefined();
  } finally {
    db.exec("DROP TRIGGER reject_retry_authorization");
  }
});

it.each(["creator", "editor"] as const)(
  "delegated runs retain every %s constraint after background acceptance",
  async (revoked) => {
    const creator = peer(),
      editor = peer(),
      manager = agent(),
      childAgent = agent();
    const team = createTeam(owner, {
      name: "Delegation fixture",
      managerId: manager.id,
      members: [childAgent.id],
    });
    let parent = creator.act(() =>
      start(manager.id, { conversationId: team.conversation_id! }),
    );
    editor.act(() => editQueuedRun(owner, parent.id, { input: "Edited work" }));
    parent = running(parent);
    const binding = nativeBindings(parent).find(
      (tool) => tool.tool === "loop_delegate",
    )!;
    await invokeNative(parent, binding, "delegate", {
      tasks: [{ agentId: childAgent.id, input: "Child work" }],
      wait: false,
    });
    const child = stored(
      "SELECT child_run_id FROM delegations WHERE parent_run_id=?",
      parent.id,
    ) as { child_run_id: string };
    (revoked === "creator" ? creator : editor).revoke();
    await blocked(ownedRun(child.child_run_id, owner));
  },
);

it.each(["model-boundary", "live"] as const)(
  "accepted %s steering constrains the locally created receiving run",
  async (delivery) => {
    const sender = peer(),
      run = running(start());
    const receipt = sender.act(() =>
      submit(owner, {
        agentId: run.agent_id!,
        conversationId: run.conversation_id!,
        input: "Peer-controlled instructions",
        idempotencyKey: randomUUID(),
        steer: true,
      }),
    );
    expect(receipt).toHaveProperty("steeringId");
    const inbox = new SteeringInbox(run);
    if (delivery === "model-boundary")
      db.transaction(() => expect(inbox.appendPending([])).toBe(1)).immediate();
    else {
      let deliveries = 0;
      const stop = inbox.listen(async () => {
        deliveries++;
      });
      await stop();
      expect(deliveries).toBe(1);
    }
    sender.revoke();
    await blocked(run);
  },
);

it("rolls back a delegated child if retaining its authorization fails", async () => {
  const sender = peer(),
    manager = agent(),
    worker = agent();
  const team = createTeam(owner, {
    name: "Atomic delegation",
    managerId: manager.id,
    members: [worker.id],
  });
  const parent = running(
    sender.act(() =>
      start(manager.id, { conversationId: team.conversation_id! }),
    ),
  );
  const binding = nativeBindings(parent).find(
    (tool) => tool.tool === "loop_delegate",
  )!;
  const before = stored("SELECT count(*) n FROM runs");
  db.exec(
    "CREATE TEMP TRIGGER fleet_inheritance_failure BEFORE INSERT ON fleet_effect_edit_authorizations BEGIN SELECT RAISE(ABORT,'fixture inheritance failure'); END",
  );
  try {
    await expect(
      invokeNative(parent, binding, "failed-child", {
        tasks: [{ agentId: worker.id, input: "Must roll back" }],
        wait: false,
      }),
    ).rejects.toThrow("fixture inheritance failure");
  } finally {
    db.exec("DROP TRIGGER fleet_inheritance_failure");
  }
  expect(stored("SELECT count(*) n FROM runs")).toEqual(before);
  expect(
    stored(
      "SELECT count(*) n FROM delegations WHERE parent_run_id=?",
      parent.id,
    ),
  ).toEqual({ n: 0 });
});

it("rolls back steering input if retaining the receiving run's authorization fails", () => {
  const sender = peer(),
    run = running(start());
  const before = stored(
    "SELECT count(*) n FROM messages WHERE run_id=?",
    run.id,
  );
  db.exec(
    "CREATE TEMP TRIGGER fleet_steering_failure BEFORE INSERT ON fleet_effect_edit_authorizations BEGIN SELECT RAISE(ABORT,'fixture steering failure'); END",
  );
  try {
    expect(() =>
      sender.act(() =>
        submit(owner, {
          agentId: run.agent_id!,
          conversationId: run.conversation_id!,
          input: "Must roll back",
          idempotencyKey: randomUUID(),
          steer: true,
        }),
      ),
    ).toThrow("fixture steering failure");
  } finally {
    db.exec("DROP TRIGGER fleet_steering_failure");
  }
  expect(
    stored("SELECT count(*) n FROM messages WHERE run_id=?", run.id),
  ).toEqual(before);
  expect(
    stored("SELECT count(*) n FROM run_steering WHERE run_id=?", run.id),
  ).toEqual({ n: 0 });
});

it("never-delivered mail keeps its constraints when requeued after the receiving run ends", async () => {
  const sender = peer(),
    recipient = agent(),
    source = running(sender.act(() => start())),
    target = running(start(recipient.id));
  const result = sendMail(source, randomUUID(), {
    to: recipient.id,
    body: "Unread input",
    scope: "direct",
    interrupt: true,
    conversationId: target.conversation_id,
  });
  const { transition } = await import("../src/server/queue.js");
  transition(target, "completed");
  sweepAgentMail();
  const mail = stored(
    "SELECT requeued_run_id FROM agent_mail WHERE id=?",
    result.messageId,
  ) as { requeued_run_id: string };
  expect(mail.requeued_run_id).toEqual(expect.any(String));
  sender.revoke();
  await blocked(ownedRun(mail.requeued_run_id, owner));
});

it.each([
  ["approve", "accepted"],
  ["reject", "accepted"],
  ["approve", "unknown"],
  ["reject", "unknown"],
] as const)(
  "a peer %s decision constrains an %s native run that resumes without a queue transition",
  async (decision, dispatch) => {
    const sender = peer(),
      run = running(start());
    const { requestApproval, decide } =
      await import("../src/server/approvals.js");
    const approval = requestApproval(run, { type: "fixture" });
    db.prepare("UPDATE runs SET state='awaiting_approval' WHERE id=?").run(
      run.id,
    );
    db.prepare("INSERT INTO native_dispatch VALUES(?,?,?,?,NULL,0)").run(
      run.id,
      randomUUID(),
      "fixture",
      dispatch,
    );
    sender.act(() => decide(owner, approval.id, decision));
    expect(ownedRun(run.id, owner).state).toBe("running");
    sender.revoke();
    const local = nativeBindings(run).find(
      (tool) => tool.tool === "loop_diagram",
    )!;
    await expect(
      invokeNative(run, local, "after-peer-approval", {
        title: "Denied",
        source: "graph LR; A-->B",
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      stored(
        "SELECT count(*) n FROM fleet_effect_edit_authorizations WHERE effect_id=?",
        run.id,
      ),
    ).toEqual({ n: 1 });
  },
);

it("rolls back native rejection when retaining the peer grant fails", async () => {
  const sender = peer(),
    run = running(start());
  const { requestApproval, decide } =
    await import("../src/server/approvals.js");
  const approval = requestApproval(run, { type: "fixture" });
  db.prepare("UPDATE runs SET state='awaiting_approval' WHERE id=?").run(
    run.id,
  );
  db.prepare("INSERT INTO native_dispatch VALUES(?,?,?,?,NULL,0)").run(
    run.id,
    randomUUID(),
    "fixture",
    "accepted",
  );
  db.exec(
    "CREATE TEMP TRIGGER fleet_approval_failure BEFORE INSERT ON fleet_effect_edit_authorizations BEGIN SELECT RAISE(ABORT,'fixture approval failure'); END",
  );
  try {
    expect(() =>
      sender.act(() => decide(owner, approval.id, "reject")),
    ).toThrow("fixture approval failure");
  } finally {
    db.exec("DROP TRIGGER fleet_approval_failure");
  }
  expect(stored("SELECT state FROM approvals WHERE id=?", approval.id)).toEqual(
    {
      state: "pending",
    },
  );
  expect(ownedRun(run.id, owner).state).toBe("awaiting_approval");
});

it.each([false, true])(
  "local agent mail retains the sender's constraints with steering=%s",
  async (steer) => {
    const sender = peer(),
      recipient = agent(),
      source = running(sender.act(() => start()));
    const target = steer ? running(start(recipient.id)) : undefined;
    const result = sendMail(source, randomUUID(), {
      to: recipient.id,
      body: "Peer-originated mail",
      scope: "direct",
      ...(target
        ? { interrupt: true, conversationId: target.conversation_id }
        : {}),
    });
    const mail = stored(
      "SELECT run_id,steering_id FROM agent_mail WHERE id=?",
      result.messageId,
    ) as { run_id: string; steering_id: string | null };
    expect(Boolean(mail.steering_id)).toBe(steer);
    sender.revoke();
    await blocked(ownedRun(mail.run_id, owner));
  },
);

it("refuses delayed local mail after the sender peer is revoked", () => {
  const sender = peer(),
    recipient = agent(),
    source = running(sender.act(() => start()));
  db.prepare("UPDATE connections SET status='disconnected' WHERE id=?").run(
    account,
  );
  const result = sendMail(source, randomUUID(), {
    to: recipient.id,
    body: "Deferred peer mail",
    scope: "direct",
  });
  expect(result.delivery).toBe("pending");
  sender.revoke();
  db.prepare("UPDATE connections SET status='connected' WHERE id=?").run(
    account,
  );
  sweepAgentMail(Date.now() + 60_000);
  expect(
    stored("SELECT state,run_id FROM agent_mail WHERE id=?", result.messageId),
  ).toEqual({ state: "refused", run_id: null });
});

it("workflow children retain the peer that resumed their parent", async () => {
  const sender = peer(),
    worker = agent(),
    workflow = randomUUID();
  const value = {
    dsl: "loop.workflow/v1",
    title: "Fixture",
    inputs: {},
    agents: { worker: worker.id },
    steps: [
      { id: "work", type: "agent", agent: "worker", prompt: "Fixture work" },
    ],
    outputs: { result: "work" },
    limits: {
      maxCalls: 1,
      maxOutputTokens: 300,
      maxInputBytes: 3000,
      maxRunSeconds: 60,
    },
  };
  const source = JSON.stringify(value),
    compiled = JSON.stringify(compile(source));
  db.prepare("INSERT INTO workflows VALUES(?,?,?,?,?,?,?)").run(
    workflow,
    owner,
    "Fixture",
    1,
    source,
    compiled,
    0,
  );
  db.prepare("INSERT INTO workflow_versions VALUES(?,?,?,?,?)").run(
    workflow,
    1,
    source,
    compiled,
    0,
  );
  const { transition } = await import("../src/server/queue.js");
  const parent = startWorkflow(owner, workflow, 1, {}, randomUUID());
  transition(parent, "paused");
  sender.act(() => transition(parent, "queued"));
  await executeWorkflow(running(parent));
  const child = stored(
    "SELECT child_run_id FROM workflow_steps WHERE run_id=?",
    parent.id,
  ) as { child_run_id: string };
  sender.revoke();
  await blocked(ownedRun(child.child_run_id, owner));
});

it("agent-requested review fan-out inherits the requesting run's constraints", async () => {
  const sender = peer(),
    folder = randomUUID(),
    project = join(root, "project");
  mkdirSync(project);
  gitProject(project);
  writeFileSync(join(project, "tracked.txt"), "changed");
  db.prepare(
    "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES(?,?,'project','Fixture',0)",
  ).run(folder, owner);
  db.prepare("INSERT INTO project_paths(folder_id,path) VALUES(?,?)").run(
    folder,
    project,
  );
  const team = createPresetTeam(owner, {
    presetId: "code-review",
    name: "Review fixture",
    folderId: folder,
    selection: { connectionId: account, model: "fixture" },
    roles: {},
    idempotencyKey: randomUUID(),
  });
  const parent = running(
    sender.act(() => start(undefined, { folderId: folder })),
  );
  requestReview(parent, "review", {
    teamId: team.id,
    scope: "uncommitted",
    base: "HEAD",
    wait: false,
  });
  const children = db
    .prepare(
      "SELECT r.* FROM runs r WHERE json_extract(r.payload,'$.reviewId') IS NOT NULL",
    )
    .all() as { id: string }[];
  expect(children).toHaveLength(4);
  sender.revoke();
  for (const child of children) await blocked(ownedRun(child.id, owner));
});

it.each([
  "accepted",
  "refused",
  "uncertain",
  "resolved-before-refusal",
  "refused-after-accepted",
] as const)(
  "native answer recovery retains only accepted or uncertain contributions: %s",
  async (outcome) => {
    const sender = peer(),
      run = running(start()),
      generation = randomUUID();
    const adapter = nativeAdapter("codex");
    const answer = vi.spyOn(adapter, "answer").mockResolvedValue();
    const live = nativeLive(run, adapter, "codex", generation, { run });
    const decisions = new NativeDecisions({
      live: new Map([[run.conversation_id!, live]]),
      interrupt: async () => {},
      answer: (...args) => decisions.answer(...args),
    });
    const request = (native: string) => {
      decisions.request(
        live,
        run,
        {
          type: "request",
          request: {
            id: native,
            kind: "approval",
            title: "Fixture",
            detail: "Isolated fixture approval",
            choices: ["allow", "deny"],
            allow: "allow",
          },
        },
        undefined,
      );
      return (
        stored(
          "SELECT id FROM native_decisions WHERE run_id=? AND native_id=?",
          run.id,
          native,
        ) as { id: string }
      ).id;
    };
    try {
      if (outcome === "refused-after-accepted") {
        const prior = request("prior");
        await sender.act(() =>
          decisions.answer(prior, randomUUID(), { choice: "allow" }),
        );
      }
      const first = request("first");
      answer.mockImplementationOnce(async () => {
        if (outcome === "resolved-before-refusal") {
          const { finishDecisions } =
            await import("../src/server/native/decisions.js");
          finishDecisions("resolved", "id=?", [first]);
        }
        if (outcome.includes("refus"))
          throw new NotDelivered("Fixture native rejection");
        if (outcome === "uncertain") throw new Error("Fixture lost reply");
      });
      const attempted = sender.act(() =>
        decisions.answer(first, randomUUID(), { choice: "allow" }),
      );
      if (
        outcome === "refused" ||
        outcome === "refused-after-accepted" ||
        outcome === "uncertain"
      )
        await expect(attempted).rejects.toMatchObject({ status: 409 });
      else await attempted;
      expect(
        stored(
          "SELECT count(*) n FROM fleet_effect_edit_authorizations WHERE effect_id=?",
          run.id,
        ),
      ).toEqual({ n: outcome === "refused" ? 0 : 1 });
      sender.revoke();
      if (outcome === "refused") {
        await expect(
          decisions.answer(first, randomUUID(), { choice: "deny" }),
        ).resolves.toEqual({ state: "resolved" });
        expect(answer).toHaveBeenCalledTimes(2);
        return;
      }
      const second = request("second");
      const calls = answer.mock.calls.length;
      await expect(
        decisions.answer(second, "auto:" + second, { choice: "allow" }),
      ).rejects.toMatchObject({ status: 403 });
      expect(answer).toHaveBeenCalledTimes(calls);
    } finally {
      answer.mockRestore();
    }
  },
);

it.each(["accepted", "stale", "invalid-choice", "uncertain"] as const)(
  "a %s native setting records authority only once dispatch begins",
  async (outcome) => {
    const sender = peer(),
      run = running(start()),
      generation = randomUUID();
    const { NativeSessions } = await import("../src/server/native-sessions.js");
    const sessions = new NativeSessions();
    const adapter = nativeAdapter("claude");
    // Keep DirectControls and setSetting; substitute native IO only.
    const controls = adapter as unknown as {
      displayControls: DirectControls;
      sessionOptions(): Setting[];
      control(request: Record<string, unknown>): Promise<unknown>;
    };
    controls.displayControls.publish(controls.sessionOptions());
    const wire = vi.spyOn(controls, "control").mockImplementation(async () => {
      expect(
        stored(
          "SELECT count(*) n FROM fleet_effect_edit_authorizations WHERE effect_id=?",
          run.id,
        ),
      ).toEqual({ n: 1 });
      if (outcome === "uncertain")
        throw new Error("Fixture lost response after dispatch");
    });
    const live = nativeLive(run, adapter, "claude", generation, {
      run,
      waiting: true,
    });
    db.prepare(
      "INSERT INTO companion_sessions(conversation_id,harness,project,model,instructions,generation,state,updated_at) VALUES(?,'claude',?,NULL,'',?,'idle',0)",
    ).run(run.conversation_id, root, generation);
    (sessions as unknown as { live: Map<string, Live> }).live.set(
      run.conversation_id!,
      live,
    );
    try {
      const pending = sender.act(() =>
        sessions.setSetting(
          run.conversation_id!,
          "mode",
          outcome === "invalid-choice" ? "removed" : "auto",
          outcome === "stale" ? 0 : adapter.settings.revision,
          generation,
        ),
      );
      if (outcome === "accepted") await pending;
      else await expect(pending).rejects.toMatchObject({ status: 409 });
      const dispatched = outcome === "accepted" || outcome === "uncertain";
      expect(wire).toHaveBeenCalledTimes(dispatched ? 1 : 0);
      sender.revoke();
      if (dispatched) await blocked(run);
      else {
        let providerCalls = 0;
        const restore = withTestAdapter("openai", {
          async models() {
            return [];
          },
          async *stream() {
            providerCalls++;
            yield { text: "Local run continues" };
          },
        });
        try {
          await executeAgent(run);
          expect(providerCalls).toBe(1);
        } finally {
          restore();
        }
      }
    } finally {
      wire.mockRestore();
      await sessions.dispose(live);
    }
  },
);

it.each(["local", "another-peer"] as const)(
  "refuses %s live native steering after the receiving run's creator is revoked",
  async (caller) => {
    const creator = peer(),
      sender = peer(),
      run = running(creator.act(() => start())),
      generation = randomUUID();
    const { NativeSessions } = await import("../src/server/native-sessions.js");
    const sessions = new NativeSessions();
    const adapter = nativeAdapter("codex");
    const prompt = vi.spyOn(adapter, "prompt").mockResolvedValue();
    const steer = vi.spyOn(adapter, "steer").mockResolvedValue();
    const live = nativeLive(run, adapter, "codex", generation);
    // Keep execute() and its durable steering/dispatch path; substitute startup.
    (sessions as unknown as { live: Map<string, Live> }).live.set(
      run.conversation_id!,
      live,
    );
    const session = vi.spyOn(sessions, "session").mockResolvedValue(live);
    const executing = sessions.execute(run);
    try {
      await expect
        .poll(() =>
          stored("SELECT state FROM native_dispatch WHERE run_id=?", run.id),
        )
        .toEqual({ state: "accepted" });
      expect(prompt).toHaveBeenCalledTimes(1);
      creator.revoke();
      const submitInput = () =>
        submit(owner, {
          agentId: run.agent_id!,
          conversationId: run.conversation_id!,
          input: "Follow-up to revoked work",
          idempotencyKey: randomUUID(),
          steer: true,
        });
      const result =
        caller === "local" ? submitInput() : sender.act(submitInput);
      expect(result).toHaveProperty("steeringId");
      await expect
        .poll(() =>
          stored("SELECT state FROM run_steering WHERE run_id=?", run.id),
        )
        .toEqual({ state: "failed" });
      expect(steer).not.toHaveBeenCalled();
    } finally {
      live.finish?.("completed");
      await executing;
      session.mockRestore();
      prompt.mockRestore();
      steer.mockRestore();
      await sessions.dispose(live);
    }
  },
);

it.each([
  ["prompt", "creator"],
  ["prompt", "generation"],
  ["steer", "creator"],
  ["steer", "sender"],
  ["answer", "sender"],
  ["answer", "generation"],
] as const)(
  "native %s rechecks %s after adapter preparation",
  async (operation, invalidated) => {
    const creator = peer(),
      sender = peer(),
      run = running(creator.act(() => start())),
      generation = randomUUID(),
      waiting = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const { NativeSessions } = await import("../src/server/native-sessions.js");
    const sessions = new NativeSessions();
    const adapter = nativeAdapter(
      operation === "steer" ? "claude" : "codex",
      "subscription",
    );
    const methods: string[] = [],
      writes: unknown[] = [];
    const internals = adapter as unknown as {
      native: object;
      control: () => Promise<void>;
      steering: { result(): void };
      asyncQuestions: Map<string, unknown>;
    };
    // Real adapter and supervisor; native IO and its delayed reply are fixtures.
    internals.native = {
      request: async (method: string) => {
        methods.push(method);
        if (method === "account/read") {
          waiting.resolve();
          await release.promise;
          return { account: { type: "chatgpt" } };
        }
        if (method === "config/read") return { config: {} };
        return { turn: { id: "fixture", status: "inProgress" } };
      },
      write: async (value: unknown) => {
        writes.push(value);
      },
      dispose: async () => {},
    };
    internals.control = async () => {
      waiting.resolve();
    };
    const live = nativeLive(
      run,
      adapter,
      operation === "steer" ? "claude" : "codex",
      generation,
    );
    (sessions as unknown as { live: Map<string, Live> }).live.set(
      run.conversation_id!,
      live,
    );
    const session = vi.spyOn(sessions, "session").mockResolvedValue(live);
    let executing: Promise<boolean> | undefined;
    try {
      let answering: Promise<unknown> | undefined;
      let decision: string | undefined;
      if (operation === "answer") {
        live.run = run;
        const decisions = new NativeDecisions({
          live: new Map([[run.conversation_id!, live]]),
          interrupt: async () => {},
          answer: (...args) => decisions.answer(...args),
        });
        const request = {
          id: "question",
          kind: "question" as const,
          title: "Continue?",
          detail: "Fixture question",
          questions: [{ id: "q", title: "Continue?" }],
        };
        internals.asyncQuestions.set(request.id, request);
        decisions.request(live, run, { type: "request", request }, undefined);
        decision = (
          stored("SELECT id FROM native_decisions WHERE run_id=?", run.id) as {
            id: string;
          }
        ).id;
        // Observe rejection before releasing native IO.
        answering = sender
          .act(() => decisions.answer(decision!, randomUUID(), { q: ["yes"] }))
          .catch((error: unknown) => error);
      } else {
        executing = sessions.execute(run);
        if (operation === "steer") {
          await expect
            .poll(() =>
              stored(
                "SELECT state FROM native_dispatch WHERE run_id=?",
                run.id,
              ),
            )
            .toEqual({ state: "accepted" });
          sender.act(() =>
            submit(owner, {
              agentId: run.agent_id!,
              conversationId: run.conversation_id!,
              input: "Must not reach native input",
              idempotencyKey: randomUUID(),
              steer: true,
            }),
          );
        }
      }
      await waiting.promise;
      if (invalidated === "generation") live.generation = randomUUID();
      else if (invalidated === "creator") creator.revoke();
      else sender.revoke();
      release.resolve();
      if (operation === "steer") {
        internals.steering.result();
        await expect
          .poll(() =>
            stored("SELECT state FROM run_steering WHERE run_id=?", run.id),
          )
          .toEqual({ state: "failed" });
        expect(writes).toHaveLength(1); // Only the original prompt.
      } else if (operation === "answer") {
        expect(await answering).toMatchObject({ status: 409 });
        expect(
          stored("SELECT state FROM native_decisions WHERE id=?", decision),
        ).toEqual({
          state: invalidated === "generation" ? "expired" : "pending",
        });
        expect(
          stored(
            "SELECT count(*) n FROM fleet_effect_edit_authorizations WHERE effect_id=?",
            run.id,
          ),
        ).toEqual({ n: 0 });
        expect(internals.asyncQuestions.has("question")).toBe(true);
        expect(methods).not.toContain("turn/start");
      } else {
        await expect
          .poll(
            () =>
              methods.includes("turn/start") ||
              ownedRun(run.id, owner).state === "interrupted",
          )
          .toBe(true);
        expect(methods).not.toContain("turn/start");
        expect(ownedRun(run.id, owner).state).toBe("interrupted");
      }
    } finally {
      release.resolve();
      if (operation === "steer") internals.steering.result();
      live.finish?.("completed");
      await executing;
      session.mockRestore();
      await sessions.dispose(live);
    }
  },
);
