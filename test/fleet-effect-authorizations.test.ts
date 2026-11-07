import { afterAll, expect, it, vi } from "vitest";
import { Codex } from "../src/adapters/codex.js";
import { NativeOutput } from "../src/server/native-output.js";
import type { Live } from "../src/server/native/state.js";
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations } from "../src/server/migrations.js";
import { FleetAuthority } from "../src/server/fleet-authority.js";
import { directoryDigest } from "../src/server/fleet-crypto.js";
import {
  withFleetAction,
  assertFleetAction,
  currentFleetAction,
} from "../src/server/fleet-action-context.js";

const root = mkdtempSync(join(tmpdir(), "loop-fleet-effect-"));
process.env.LOOP_DATA_DIR = join(root, "local");
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, changes } = await import("../src/server/db.js");
const secrets = await import("../src/server/secrets.js");
const { enqueue, transition } = await import("../src/server/queue.js");
const { assertFleetEffect, authorizeFleetEffect, withFleetEffect } =
  await import("../src/server/fleet-effect-authorizations.js");
const { ExecutionClient } = await import("../src/server/execution-client.js");
const { NativeSessions } = await import("../src/server/native-sessions.js");
const { createAgent, ownedRun } = await import("../src/server/domain.js");
const { executeAgent } = await import("../src/server/agent-runtime.js");
const { editQueuedRun, moveQueuedRun } =
  await import("../src/server/mobile-return/queued-runs.js");
const {
  createScheduledSend,
  deliverScheduledSends,
  editScheduledSend,
  retryScheduledSend,
} = await import("../src/server/mobile-return/scheduled-sends.js");
// Fleets are on for this suite, as for a host started with --fleet.
const { registerEffectAuthority } =
  await import("../src/server/effect-authority.js");
const { fleetEffectAuthority } =
  await import("../src/server/fleet-effect-authorizations.js");
registerEffectAuthority(fleetEffectAuthority);
const owner = "local-workspace",
  peerOwner = randomUUID();
const peerDb = new Database(join(root, "peer.db"));
applyMigrations(peerDb);
peerDb.prepare("INSERT INTO deployment_profile VALUES(1,'companion')").run();
const editorDb = new Database(join(root, "editor.db"));
applyMigrations(editorDb);
editorDb.prepare("INSERT INTO deployment_profile VALUES(1,'companion')").run();
const local = new FleetAuthority(db, secrets),
  peer = new FleetAuthority(peerDb, secrets),
  editor = new FleetAuthority(editorDb, secrets);
const genesis = local.create(owner, {
  mutationId: randomUUID(),
  name: "Same label",
  origin: "https://local.example",
  scope: ["read", "act"],
});
let directory = local.revise(owner, {
  mutationId: randomUUID(),
  expected: directoryDigest(genesis.document),
  members: [
    ...genesis.document.members,
    {
      ...peer.identity,
      grantId: randomUUID(),
      name: "Same label",
      origin: "https://peer.example",
    },
    {
      ...editor.identity,
      grantId: randomUUID(),
      name: "Same label",
      origin: "https://editor.example",
    },
  ],
});
peer.approve(peerOwner, {
  mutationId: randomUUID(),
  expected: null,
  kind: "enroll",
  controller: local.identity,
  directory,
  grantId: directory.document.members[1].grantId,
  scope: ["read", "act"],
});
const grant = {
  fleetId: directory.document.fleetId,
  grantId: directory.document.members[0].grantId,
  destination: local.identity.machineId,
  peer: peer.identity.machineId,
  directory: directoryDigest(directory.document),
  operation: "act" as const,
};
const check = () => authorizeFleetEffect(owner, grant);
const accepted: string[] = [];
let waitingSchedule: { id: string; at: number };
let scheduledAgent: string;
afterAll(() => {
  db.close();
  peerDb.close();
  editorDb.close();
  rmSync(root, { recursive: true, force: true });
});

it("records the originating command with the real queue acceptance and preserves idempotent run identity", () => {
  const commandId = randomUUID();
  const context = { owner, commandId, grant };
  const create = () =>
    withFleetAction(context, check, () =>
      enqueue(owner, "Fixture work", commandId),
    );
  const run = create();
  accepted.push(run.id);
  expect(create().id).toBe(run.id);
  const rows = db.prepare("SELECT * FROM fleet_effect_authorizations").all();
  expect(rows).toEqual([
    {
      owner_id: owner,
      effect_kind: "run",
      effect_id: run.id,
      command_id: commandId,
      grant_context: JSON.stringify(grant),
    },
  ]);
  expect(() => assertFleetEffect(owner, "run", run.id)).not.toThrow();
  expect(() =>
    withFleetAction({ ...context, owner: peerOwner }, check, () =>
      enqueue(owner, "Other owner", randomUUID()),
    ),
  ).toThrow("owner");
});

it("rolls back the effect authorization when the owning queue transaction fails", () => {
  const before = db
    .prepare("SELECT count(*) n FROM fleet_effect_authorizations")
    .get();
  db.exec(
    "CREATE TEMP TRIGGER fleet_fixture_failure BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT,'fixture queue failure'); END",
  );
  try {
    expect(() =>
      withFleetAction({ owner, commandId: randomUUID(), grant }, check, () =>
        enqueue(owner, "Rejected fixture", randomUUID()),
      ),
    ).toThrow("fixture queue failure");
  } finally {
    db.exec("DROP TRIGGER fleet_fixture_failure");
  }
  expect(
    db.prepare("SELECT count(*) n FROM fleet_effect_authorizations").get(),
  ).toEqual(before);
});

it("records resume authorization atomically with its owned queue transition", () => {
  const run = enqueue(owner, "Paused local work", randomUUID());
  expect(transition(run, "paused")).toBe(true);
  const context = { owner, commandId: randomUUID(), grant };
  const resume = () =>
    withFleetAction(context, check, () => transition(run, "queued"));
  db.exec(
    "CREATE TEMP TRIGGER fleet_resume_failure BEFORE UPDATE OF state ON runs BEGIN SELECT RAISE(ABORT,'fixture resume failure'); END",
  );
  try {
    expect(resume).toThrow("fixture resume failure");
  } finally {
    db.exec("DROP TRIGGER fleet_resume_failure");
  }
  expect(ownedRun(run.id, owner).state).toBe("paused");
  expect(
    db
      .prepare(
        "SELECT 1 FROM fleet_effect_edit_authorizations WHERE effect_id=?",
      )
      .get(run.id),
  ).toBeUndefined();
  expect(
    withFleetAction(context, check, () =>
      transition({ ...run, owner_id: peerOwner }, "queued"),
    ),
  ).toBe(false);
  expect(resume()).toBe(true);
  expect(
    db
      .prepare(
        "SELECT command_id,grant_context FROM fleet_effect_edit_authorizations WHERE owner_id=? AND effect_id=?",
      )
      .get(owner, run.id),
  ).toEqual({
    command_id: context.commandId,
    grant_context: JSON.stringify(grant),
  });
});

it("delivers committed events without transferring the waking peer's authority into unrelated work", async () => {
  let target: string | undefined;
  let resolve!: (result: {
    context?: unknown;
    error?: unknown;
    id?: string;
  }) => void;
  const delivered = new Promise<{
    context?: unknown;
    error?: unknown;
    id?: string;
  }>((done) => {
    resolve = done;
  });
  const unsubscribe = changes.subscribe(owner, (events) => {
    if (!events.some((event) => event.run_id === target)) return;
    const context = currentFleetAction();
    try {
      const run = enqueue(
        peerOwner,
        "Independent committed-event work",
        randomUUID(),
      );
      resolve({ context, id: run.id });
    } catch (error) {
      resolve({ context, error });
    }
  });
  try {
    // Drain the subscription's initial wake before the peer supplies a new one.
    await new Promise<void>((done) => setImmediate(done));
    target = withFleetAction(
      { owner, commandId: randomUUID(), grant },
      check,
      () => enqueue(owner, "Wake a shared consumer", randomUUID()),
    ).id;
    const result = await delivered;
    expect(result.context).toBeUndefined();
    expect(result.error).toBeUndefined();
    expect(result.id).toBeDefined();
    expect(
      db
        .prepare("SELECT 1 FROM fleet_effect_authorizations WHERE effect_id=?")
        .get(result.id),
    ).toBeUndefined();
  } finally {
    unsubscribe();
  }
});

it("carries the same command and grant across the private native transport and refuses replacement identities", async () => {
  const client = new ExecutionClient(),
    generation = randomUUID(),
    commandId = randomUUID();
  const sent: unknown[] = [];
  client.connect({
    status: () => ({ v: 1, generation, state: "ready" }),
    send: async (request) => {
      sent.push(request);
      return {
        v: 1,
        generation,
        requestId: request.requestId,
        ok: true,
        result: { state: "resolved" },
      };
    },
  });
  try {
    const input = { decisionId: randomUUID(), answer: {} };
    await withFleetAction({ owner, commandId, grant }, check, () =>
      client.request("native.answer", input),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ owner, commandId, fleet: grant });
    await expect(
      withFleetAction({ owner, commandId, grant }, check, () =>
        client.request("native.answer", input, { commandId: randomUUID() }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(sent).toHaveLength(1);
  } finally {
    client.disconnect();
  }
});

it("rolls back input and editing authorization together, and rejects another owner's edit", () => {
  const run = enqueue(owner, "Keep this input", randomUUID());
  const before = db
    .prepare("SELECT count(*) n FROM fleet_effect_edit_authorizations")
    .get();
  db.exec(
    "CREATE TEMP TRIGGER fleet_edit_failure BEFORE UPDATE OF input ON runs BEGIN SELECT RAISE(ABORT,'fixture edit failure'); END",
  );
  try {
    expect(() =>
      withFleetAction({ owner, commandId: randomUUID(), grant }, check, () =>
        editQueuedRun(owner, run.id, { input: "Rejected change" }),
      ),
    ).toThrow("fixture edit failure");
  } finally {
    db.exec("DROP TRIGGER fleet_edit_failure");
  }
  expect(ownedRun(run.id, owner).input).toBe("Keep this input");
  expect(
    db.prepare("SELECT count(*) n FROM fleet_effect_edit_authorizations").get(),
  ).toEqual(before);
  expect(() =>
    withFleetAction(
      { owner: peerOwner, commandId: randomUUID(), grant },
      check,
      () => editQueuedRun(owner, run.id, { input: "Wrong owner" }),
    ),
  ).toThrow("owner");
  expect(ownedRun(run.id, owner).input).toBe("Keep this input");
});

it("retains the original grant and command when a scheduled message becomes a queued run", () => {
  const connectionId = randomUUID();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,?,'openai','Fixture','','connected',?,'{}',0)",
  ).run(connectionId, owner, JSON.stringify([{ id: "fixture" }]));
  const agent = createAgent(owner, {
    name: "fleet-scheduled-fixture",
    connectionId,
    model: "fixture",
  });
  scheduledAgent = agent.id;
  const commandId = randomUUID(),
    at = Date.now() + 60_000;
  const schedule = (sendAt: number, key: string) =>
    withFleetAction({ owner, commandId, grant }, check, () =>
      createScheduledSend(owner, {
        agentId: agent.id,
        input: "Isolated scheduled fixture",
        sendAt,
        idempotencyKey: key,
      }),
    ).row;
  const first = schedule(at, randomUUID());
  const second = schedule(at + 60_000, randomUUID());
  waitingSchedule = { id: second.id, at: second.send_at };
  expect(deliverScheduledSends(at)).toBe(1);
  const receipt = db
    .prepare("SELECT state,run_id FROM scheduled_sends WHERE id=?")
    .get(first.id) as { state: string; run_id: string };
  expect(receipt.state).toBe("submitted");
  expect(
    db
      .prepare(
        "SELECT command_id,grant_context FROM fleet_effect_authorizations WHERE owner_id=? AND effect_kind='run' AND effect_id=?",
      )
      .get(owner, receipt.run_id),
  ).toEqual({ command_id: commandId, grant_context: JSON.stringify(grant) });
  expect(deliverScheduledSends(at)).toBe(0);
});

it("fences locally created and peer-created work after its editing peer is revoked, including scheduled conversion and retry", async () => {
  const editorGrant = { ...grant, peer: editor.identity.machineId };
  const edited = <T>(apply: () => T) =>
    withFleetAction(
      { owner, commandId: randomUUID(), grant: editorGrant },
      () => authorizeFleetEffect(owner, editorGrant),
      apply,
    );
  const originalCommand = randomUUID();
  const localRun = enqueue(owner, "Local queued input", randomUUID());
  const peerRun = withFleetAction(
    { owner, commandId: originalCommand, grant },
    check,
    () => enqueue(owner, "Peer queued input", originalCommand),
  );
  for (const run of [localRun, peerRun])
    edited(() => editQueuedRun(owner, run.id, { input: "Peer-edited input" }));
  const resumed = [
    enqueue(owner, "Local paused input", randomUUID()),
    withFleetAction({ owner, commandId: randomUUID(), grant }, check, () =>
      enqueue(owner, "Peer paused input", randomUUID()),
    ),
  ];
  for (const run of resumed) {
    expect(transition(run, "paused")).toBe(true);
    expect(edited(() => transition(run, "queued"))).toBe(true);
  }
  const moved = moveQueuedRun(owner, localRun.id, {
    agentId: scheduledAgent,
    idempotencyKey: randomUUID(),
  });
  const at = Date.now() + 30_000;
  const schedule = (sendAt: number) =>
    createScheduledSend(owner, {
      agentId: scheduledAgent,
      input: "Local scheduled input",
      sendAt,
      idempotencyKey: randomUUID(),
    }).row;
  const converted = schedule(at),
    waiting = schedule(at + 15_000);
  for (const row of [converted, waiting])
    edited(() =>
      editScheduledSend(owner, row.id, { input: "Peer-edited schedule" }),
    );
  const retry = schedule(at + 15_000);
  db.prepare("UPDATE scheduled_sends SET state='failed' WHERE id=?").run(
    retry.id,
  );
  const retried = edited(() => retryScheduledSend(owner, retry.id));
  expect(retried.run).not.toBeNull();
  expect(deliverScheduledSends(at)).toBe(1);
  const convertedRun = db
    .prepare("SELECT run_id FROM scheduled_sends WHERE id=?")
    .get(converted.id) as { run_id: string };
  // Editing cannot replace the creator's durable command and grant.
  expect(
    db
      .prepare(
        "SELECT command_id,grant_context FROM fleet_effect_authorizations WHERE effect_kind='run' AND effect_id=?",
      )
      .get(peerRun.id),
  ).toEqual({
    command_id: originalCommand,
    grant_context: JSON.stringify(grant),
  });
  directory = local.revise(owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(directory.document),
    members: directory.document.members.filter(
      (member) => member.machineId !== editor.identity.machineId,
    ),
  });
  const sessions = new NativeSessions();
  for (const id of [
    localRun.id,
    peerRun.id,
    moved.id,
    convertedRun.run_id,
    retried.run!.id,
    ...resumed.map((run) => run.id),
  ]) {
    expect(() => assertFleetEffect(owner, "run", id)).toThrow("grant");
    const run = ownedRun(id, owner);
    await expect(sessions.execute(run)).rejects.toMatchObject({ status: 403 });
    await expect(executeAgent(run)).rejects.toMatchObject({ status: 403 });
  }
  expect(deliverScheduledSends(waiting.send_at)).toBe(0);
  expect(
    db
      .prepare("SELECT state,run_id FROM scheduled_sends WHERE id=?")
      .get(waiting.id),
  ).toEqual({ state: "failed", run_id: null });
});

it("refuses retained queued effects and a delayed async action after the peer is revoked", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let effects = 0;
  const pending = withFleetAction(
    { owner, commandId: randomUUID(), grant },
    check,
    async () => {
      await gate;
      assertFleetAction(owner);
      effects++;
    },
  ).catch((error: unknown) => error);
  const conversation = randomUUID(),
    generation = randomUUID();
  db.prepare(
    "INSERT INTO conversations(id,owner_id,title,created_at) VALUES(?,?,'Fleet setting fixture',0)",
  ).run(conversation, owner);
  db.prepare(
    "INSERT INTO companion_sessions(worktree_agent_id,conversation_id,harness,project,model,instructions,generation,state,updated_at) VALUES('fixture-agent',?,'codex',?,NULL,'',?,'idle',0)",
  ).run(conversation, root, generation);
  const adapter = new Codex(
    {
      harness: "codex",
      executable: process.execPath,
      project: root,
      version: "fixture",
      billing: "existing",
    },
    () => {},
  );
  const settingCall = vi
    .spyOn(adapter, "setSetting")
    .mockResolvedValue({ revision: 1, options: [] });
  const live: Live = {
    adapter,
    generation,
    binding: {
      worktree_source: null,
      worktree_agent_id: "fixture-agent",
      conversation_id: conversation,
      harness: "codex",
      project: root,
      native_id: null,
      model: null,
      instructions: "",
      generation,
      state: "idle",
    },
    ready: gate,
    bootstrapRun: enqueue(owner, "Native setting fixture", randomUUID(), {
      conversation,
    }),
    items: new NativeOutput(),
    requests: new Map(),
    closed: false,
    cancelling: false,
    waiting: false,
    bridgeWaiting: 0,
  };
  const sessions = new NativeSessions();
  (sessions as unknown as { live: Map<string, Live> }).live.set(
    conversation,
    live,
  );
  const setting = withFleetAction(
    { owner, commandId: randomUUID(), grant },
    check,
    () => sessions.setSetting(conversation, "mode", "auto", 0, generation),
  ).catch((error: unknown) => error);
  const client = new ExecutionClient();
  let sent = 0;
  client.connect({
    status: () => ({ v: 1, generation, state: "ready" }),
    send: async (request) => {
      sent++;
      return {
        v: 1,
        generation,
        requestId: request.requestId,
        ok: true,
        result: { state: "resolved" },
      };
    },
  });
  const send = withFleetAction(
    { owner, commandId: randomUUID(), grant },
    check,
    () =>
      client.request("native.answer", { decisionId: randomUUID(), answer: {} }),
  ).catch((error: unknown) => error);
  local.revise(owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(directory.document),
    members: directory.document.members.filter(
      (member) => member.machineId !== peer.identity.machineId,
    ),
  });
  release();
  expect(await pending).toMatchObject({ status: 403 });
  try {
    expect(await setting).toMatchObject({ status: 403 });
    expect(settingCall).not.toHaveBeenCalled();
    expect(await send).toMatchObject({ status: 403 });
    expect(sent).toBe(0);
  } finally {
    settingCall.mockRestore();
    client.disconnect();
    await sessions.dispose(live);
  }
  expect(effects).toBe(0);
  expect(() =>
    withFleetEffect(owner, "run", accepted[0], () => {
      effects++;
    }),
  ).toThrow("grant");
  expect(effects).toBe(0);
  expect(() => assertFleetEffect(owner, "run", accepted[0])).toThrow("grant");
  const queued = ownedRun(accepted[0], owner);
  await expect(sessions.execute(queued)).rejects.toMatchObject({ status: 403 });
  await expect(executeAgent(queued)).rejects.toMatchObject({ status: 403 });
  expect(deliverScheduledSends(waitingSchedule.at)).toBe(0);
  expect(
    db
      .prepare("SELECT state,run_id FROM scheduled_sends WHERE id=?")
      .get(waitingSchedule.id),
  ).toEqual({ state: "failed", run_id: null });
});
