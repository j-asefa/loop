import { createHost } from "./helpers/gateway.js";
import { afterAll, afterEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { Response, type fetch as PeerFetch } from "undici";
import { Host } from "../src/host.js";
import { applyMigrations } from "../src/server/migrations.js";
import { FleetAuthority } from "../src/server/fleet-authority.js";
import { FleetCredentials } from "../src/server/fleet-credentials.js";
import { FleetCredentialLeases } from "../src/server/fleet-credential-leases.js";
import { FleetPairing } from "../src/server/fleet-pairing.js";
import { FleetEnrollmentDestination } from "../src/server/fleet-enrollment.js";
import { FleetMailDestination } from "../src/server/fleet-mail-destination.js";
import { FleetMailJournal } from "../src/server/fleet-mail-journal.js";
import { directoryDigest } from "../src/server/fleet-crypto.js";
import {
  fleetAgentAddress,
  type FleetMailEnvelope,
} from "../src/shared/fleet-mail.js";
import { fleetMailApi } from "../src/shared/fleet-mail-api.js";
import type { Binding, Live } from "../src/server/native/state.js";
import { NativeOutput } from "../src/server/native-output.js";
import { Codex } from "../src/adapters/codex.js";
import { FleetAdminState } from "../src/shared/fleet-admin-api.js";
import { mailConversationTarget } from "../src/client/mailReferences.js";

const dir = mkdtempSync(join(tmpdir(), "loop-fleet-mail-outgoing-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { FleetCredentialHttpTransport } =
  await import("../src/server/fleet-credential-http.js");
const { FleetMailHttpTransport } =
  await import("../src/server/fleet-mail-http.js");
const { FleetPeerMail } = await import("../src/server/fleet-peer-mail.js");
const { FleetCapacity } = await import("../src/server/fleet-capacity.js");
const secrets = await import("../src/server/secrets.js");
const { db, id, now } = await import("../src/server/db.js");
const { createAgent, ownedRun } = await import("../src/server/domain.js");
const { storePublishedFile } = await import("../src/server/published-files.js");
const { uploadFile } = await import("../src/server/uploads.js");
const { outgoingFleetMailFile } =
  await import("../src/server/fleet-mail-origin.js");
const { submit } = await import("../src/server/agent-runtime.js");
const { claim, transition } = await import("../src/server/queue.js");
const { NativeProjector } = await import("../src/server/native/projector.js");
const { sendMail, resumeThread, agentMessages, sweepAgentMail, mailStatus } =
  await import("../src/server/agent-mail.js");
const { withFleetAction } =
  await import("../src/server/fleet-action-context.js");
const { authorizeFleetEffect, assertFleetEffect } =
  await import("../src/server/fleet-effect-authorizations.js");
const { FleetMailDrainer } =
  await import("../src/server/fleet-mail-drainer.js");
const { authorizeFleetMailSender } =
  await import("../src/server/fleet-mail-origin.js");
const { FleetMailServices } =
  await import("../src/server/fleet-mail-services.js");
const { installFleetMailTools, assertFleetMailTools } =
  await import("../src/server/fleet-mail-tools.js");
const { createFleetPeerHttp } =
  await import("../src/server/fleet-peer-http.js");
// Fleets are on for this suite, as for a host started with --fleet.
const { registerEffectAuthority } =
  await import("../src/server/effect-authority.js");
const { fleetEffectAuthority } =
  await import("../src/server/fleet-effect-authorizations.js");
registerEffectAuthority(fleetEffectAuthority);
const owner = "source-owner",
  peerOwner = "different-destination-owner";
const authority = new FleetAuthority(db, secrets);
const peerDb = new Database(":memory:");
applyMigrations(peerDb);
peerDb.prepare("INSERT INTO deployment_profile VALUES(1,'companion')").run();
peerDb.exec(
  "CREATE TABLE fixture_mail_queue(id TEXT PRIMARY KEY,body TEXT NOT NULL)",
);
const peerAuthority = new FleetAuthority(peerDb, secrets);
let origin = "https://destination.example";
const first = authority.create(owner, {
  mutationId: id(),
  name: "Source",
  origin: "https://source.example",
  scope: ["read", "mail", "files", "act"],
});
let directory = authority.revise(owner, {
  mutationId: id(),
  expected: directoryDigest(first.document),
  members: [
    ...first.document.members,
    { ...peerAuthority.identity, grantId: id(), name: "Destination", origin },
  ],
});
peerAuthority.approve(peerOwner, {
  mutationId: id(),
  expected: null,
  kind: "enroll",
  scope: ["read", "mail", "files"],
  controller: authority.identity,
  directory,
  grantId: directory.document.members[1].grantId,
});
const credentials = new FleetCredentials(db, authority, secrets);
const peerCredentials = new FleetCredentials(peerDb, peerAuthority, secrets);
const journal = new FleetMailJournal(db, authority, owner);
const received: FleetMailEnvelope[] = [];
let deliveryStatus: "queued" | "handled" = "queued";
let admittedConversation: string | null | undefined;
const completedConversations = new Map<string, string>();
const service = new FleetMailDestination(
  peerDb,
  peerAuthority,
  peerCredentials,
  peerOwner,
  secrets,
  {
    directory: () => ({ agents: [], nextOffset: null }),
    admit: (envelope) => {
      received.push(envelope);
      peerDb
        .prepare("INSERT INTO fixture_mail_queue VALUES(?,?)")
        .run(envelope.messageId, envelope.body);
      return {
        state: "accepted",
        mailId: id(),
        threadId: id(),
        conversationId:
          admittedConversation === undefined ? id() : admittedConversation,
        status: "queued",
      };
    },
    inspect: (admission) =>
      admission.state === "accepted"
        ? {
            ...admission,
            status: deliveryStatus,
            conversationId:
              completedConversations.get(admission.mailId) ??
              admission.conversationId,
          }
        : admission,
  },
);
const pairing = new FleetPairing(peerDb, peerAuthority, peerOwner, dir);
const enrollment = new FleetEnrollmentDestination(
  peerDb,
  peerAuthority,
  pairing,
  peerOwner,
  secrets,
  () => origin,
);
const host = createHost(dir, pairing);
host.workspace = {
  http: (_request, response) => {
    response.writeHead(404).end();
  },
  peerHttp: createFleetPeerHttp(enrollment, () => origin, {
    credentials: peerCredentials,
    mail: service,
  }),
  status: () => ({}),
  admin: async () => ({}),
  connect: () => () => {},
  originChanged: () => {},
};
await host.listen();
host.setOrigin(origin);
let mode: "normal" | "offline" | "lost" | "before-accept" | "forbidden" =
  "normal";
const calls: string[] = [];
let beforePreparedReply: (() => void) | undefined;
const fetcher: typeof PeerFetch = async (url, options) => {
  const target = new URL(String(url));
  expect(target.origin).toBe(origin);
  calls.push(target.pathname);
  if (mode === "offline") throw new Error("fixture offline");
  if (mode === "forbidden")
    return new Response(
      JSON.stringify({ error: "fixture authentication unavailable" }),
      {
        status: 403,
        headers: { "content-type": "application/json" },
      },
    );
  const input = JSON.parse(String(options?.body));
  if (target.pathname === "/api" + fleetMailApi.accept.path) {
    expect(journal.outgoing(input.envelope.messageId)?.state).toBe("unknown");
    if (mode === "before-accept")
      throw new Error("fixture request lost before destination");
  }
  const reply = await new Promise<{ status: number; body: string }>(
    (resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port: host.port,
          path: target.pathname,
          method: "POST",
          signal: options?.signal ?? undefined,
          headers: {
            host: target.host,
            "content-type": "application/json",
            "x-loop-fleet-version": "1",
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () =>
            resolve({
              status: res.statusCode!,
              body: Buffer.concat(chunks).toString(),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify(input));
    },
  );
  if (target.pathname === "/api" + fleetMailApi.prepare.path)
    beforePreparedReply?.();
  if (target.pathname === "/api" + fleetMailApi.accept.path && mode === "lost")
    throw new Error("fixture lost receipt");
  return new Response(reply.body, {
    status: reply.status,
    headers: { "content-type": "application/json" },
  });
};
const capacity = new FleetCapacity(() => true);
const leases = new FleetCredentialLeases(
  authority,
  credentials,
  owner,
  new FleetCredentialHttpTransport(fetcher, capacity),
);
const transport = new FleetMailHttpTransport(fetcher, capacity);
let time = Date.now();
const drainers: InstanceType<typeof FleetMailDrainer>[] = [];
function drainer() {
  const instance = new FleetMailDrainer(
    authority,
    owner,
    journal,
    new FleetPeerMail(authority, leases, owner, journal, transport),
    () => time,
  );
  drainers.push(instance);
  return instance;
}
let disable = installFleetMailTools(owner);
afterEach(() => {
  for (const instance of drainers.splice(0)) instance.close();
  mode = "normal";
  beforePreparedReply = undefined;
  deliveryStatus = "queued";
  admittedConversation = undefined;
  completedConversations.clear();
  calls.length = 0;
  received.length = 0;
  db.exec(
    "DELETE FROM agent_threads; DELETE FROM fleet_mail_outbox; UPDATE runs SET state='completed'",
  );
});
afterAll(async () => {
  disable();
  leases.close();
  service.close();
  await host.close();
  peerDb.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
function source(harness?: string) {
  const connection = id();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,?,'openai','Fixture',?,'connected',?,?,?)",
  ).run(
    connection,
    owner,
    secrets.seal("fixture", owner),
    JSON.stringify([{ id: "fixture" }]),
    JSON.stringify(harness ? { loopHarness: harness } : {}),
    now(),
  );
  const agent = createAgent(owner, {
    name: "fixture-" + id().slice(0, 20),
    connectionId: connection,
    model: "fixture",
  });
  const queued = submit(owner, {
    agentId: agent.id,
    input: "Send mail",
    idempotencyKey: id(),
  });
  const run = claim("fixture", (candidate) => candidate.id === queued.id)!;
  if (harness) {
    const generation = id();
    db.prepare(
      "INSERT INTO companion_sessions(worktree_agent_id,conversation_id,harness,project,generation,state,updated_at) VALUES('fixture-agent',?,?,?,?,'running',?)",
    ).run(run.conversation_id, harness, dir, generation, now());
    db.prepare(
      "INSERT INTO native_dispatch VALUES(?,?,?,'accepted',NULL,?)",
    ).run(run.id, generation, "fixture", now());
  }
  return { agent, run };
}
function finishNative(run: ReturnType<typeof source>["run"]) {
  const binding = db
    .prepare("SELECT * FROM companion_sessions WHERE conversation_id=?")
    .get(run.conversation_id) as Binding;
  const live: Live = {
    binding,
    generation: binding.generation,
    run,
    bootstrapRun: run,
    ready: Promise.resolve(),
    // Projection does not launch an adapter. Framing is covered by the native
    // subprocess fixtures; this exercises their shared terminal-event boundary.
    adapter: new Codex(
      {
        harness: "codex",
        executable: "",
        project: dir,
        version: "fixture",
        billing: "existing",
      },
      () => {},
    ),
    items: new NativeOutput(),
    requests: new Map(),
    closed: false,
    cancelling: false,
    waiting: false,
    bridgeWaiting: 0,
    finish: () => transition(run, "completed"),
  };
  new NativeProjector({
    live: new Map([[binding.conversation_id, live]]),
    interrupt: async () => {
      throw new Error("Unexpected native interruption");
    },
    dispose: async () => {
      throw new Error("Unexpected native disposal");
    },
    request: () => false,
    projectOutput: () => {},
  }).event(live, { type: "status", status: "completed" });
  expect(
    db.prepare("SELECT state FROM native_dispatch WHERE run_id=?").get(run.id),
  ).toEqual({ state: "completed" });
}
const remote = () =>
  fleetAgentAddress({
    machineId: peerAuthority.identity.machineId,
    agentId: id(),
  });
function visible(agentId: string) {
  return agentMessages(owner, agentId).threads[0].messages.at(-1)!;
}
function wake() {
  time += 300_001;
  journal.wake();
}

it("keeps remote sends unavailable until the owning lifecycle installs them", () => {
  const { run } = source();
  disable();
  expect(() =>
    sendMail(run, "disabled", { to: remote(), body: "not stored" }),
  ).toThrow(/unavailable/);
  expect(db.prepare("SELECT count(*) n FROM agent_mail").get()).toEqual({
    n: 0,
  });
  disable = installFleetMailTools(owner);
});

it("persists a single source-owned envelope before IO and reconciles destination progress without a local run", async () => {
  const { agent, run } = source();
  const input = { to: remote(), body: "only the destination can read this" };
  const first = sendMail(run, "one", input);
  expect(first.delivery).toBe("transport_pending");
  expect(visible(agent.id).remote_conversation).toBeNull();
  const binding = db
    .prepare(
      "SELECT remote_name FROM fleet_mail_threads WHERE owner_id=? AND thread_id=?",
    )
    .get(owner, first.threadId) as { remote_name: string };
  const status = mailStatus(run, { threadId: first.threadId });
  if (!("messages" in status)) throw new Error("Expected thread messages");
  expect(status.messages[0]).toMatchObject({
    from: "@" + agent.name,
    to: "@" + binding.remote_name,
  });
  expect(calls).toEqual([]);
  expect(sendMail(run, "one", input).messageId).toBe(first.messageId);
  expect(() => sendMail(run, "one", { ...input, body: "conflict" })).toThrow(
    /identity/,
  );
  expect(
    new FleetMailJournal(db, authority, "another-owner").outgoing(
      first.messageId,
    ),
  ).toBeNull();
  const senderRuns = db.prepare("SELECT count(*) n FROM runs").get();
  const drain = drainer();
  await drain.drain();
  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({
    messageId: first.messageId,
    sender: { runId: run.id, conversationId: run.conversation_id },
  });
  expect(db.prepare("SELECT count(*) n FROM runs").get()).toEqual(senderRuns);
  expect(visible(agent.id).status).toBe("queued");
  expect(visible(agent.id).conversation_id).toBeNull();
  const message = visible(agent.id);
  expect(message.to_ref).toMatchObject({
    kind: "peer",
    machineId: peerAuthority.identity.machineId,
    agentId: received[0].destination.agentId,
  });
  expect(message.remote_conversation).toMatchObject({
    machineId: peerAuthority.identity.machineId,
    conversationId: expect.any(String),
  });
  const gateway = FleetAdminState.parse({
    identity: authority.identity,
    origin: "https://source.example",
    state: "controller",
    head: directoryDigest(directory.document),
    directory,
    scope: ["read", "mail"],
    pendingDistribution: 0,
    unconfirmed: [],
  });
  expect(
    mailConversationTarget(message, "peer:some-other-sheet", gateway),
  ).toEqual({
    id: message.remote_conversation!.conversationId,
    source: `peer:${peerAuthority.identity.machineId}`,
  });
  expect(
    mailConversationTarget(message, `peer:${authority.identity.machineId}`, {
      ...gateway,
      identity: peerAuthority.identity,
      state: "replica",
    }),
  ).toEqual({
    id: message.remote_conversation!.conversationId,
    source: "",
  });
  expect(mailConversationTarget(message, "", null)).toBeNull();
  expect(
    mailConversationTarget({ ...message, to_ref: undefined }, "", gateway),
  ).toBeNull();
  expect(
    mailConversationTarget(
      {
        ...message,
        remote_conversation: {
          ...message.remote_conversation!,
          machineId: authority.identity.machineId,
        },
      },
      "",
      gateway,
    ),
  ).toBeNull();
  expect(mailConversationTarget(message, "", gateway, true)).toBeNull();
  expect(
    mailConversationTarget(message, "", { ...gateway, scope: ["mail"] }),
  ).toBeNull();
  expect(
    mailConversationTarget(message, "", { ...gateway, state: "removed" }),
  ).toBeNull();
  deliveryStatus = "handled";
  wake();
  await drain.drain();
  expect(visible(agent.id).status).toBe("handled");
  expect(journal.outgoing(first.messageId)?.settled).toBe(true);
  expect(received).toHaveLength(1);
});

it("keeps interrupt receipt targets separate from an unresolved ordinary thread default", async () => {
  const { run } = source(),
    to = remote(),
    drain = drainer();
  const first = sendMail(run, "ordinary", {
    to,
    body: "Waiting for destination capacity",
  });
  admittedConversation = null;
  await drain.drain();
  const admission = journal.outgoing(first.messageId)!.receipt!.admission;
  if (admission.state !== "accepted") throw new Error("Expected admission");
  const bound = () =>
    (
      db
        .prepare(
          "SELECT conversation_id id FROM agent_thread_members WHERE thread_id=? AND agent_id=?",
        )
        .get(first.threadId, to) as { id: string | null }
    ).id;
  expect(bound()).toBeNull();
  const interrupt = id();
  admittedConversation = interrupt;
  const second = sendMail(run, "interrupt", {
    to,
    threadId: first.threadId,
    body: "Target an existing conversation",
    interrupt: true,
    conversationId: interrupt,
  });
  await drain.drain();
  expect(bound()).toBeNull();
  const ordinary = id();
  completedConversations.set(admission.mailId, ordinary);
  wake();
  await drain.drain();
  expect(bound()).toBe(ordinary);
  expect(
    db
      .prepare("SELECT recipient_conversation_id id FROM agent_mail WHERE id=?")
      .get(second.messageId),
  ).toEqual({ id: interrupt });
  const next = sendMail(run, "follow-up", {
    to,
    threadId: first.threadId,
    body: "Use the ordinary thread default",
  });
  expect(
    journal.pendingEnvelope(next.messageId)?.thread.recipientConversationId,
  ).toBe(ordinary);
});

it("projects receipts despite malformed local retry metadata without blocking healthy outgoing mail", async () => {
  const firstSource = source(),
    secondSource = source();
  const first = sendMail(firstSource.run, "damaged-projection", {
    to: remote(),
    body: "Already accepted remotely",
  });
  const peer = new FleetPeerMail(authority, leases, owner, journal, transport);
  try {
    await peer.deliver(first.messageId, (envelope) =>
      authorizeFleetMailSender(owner, envelope),
    );
  } finally {
    peer.close();
  }
  expect(journal.outgoing(first.messageId)?.state).toBe("accepted");
  const digest = journal.outgoing(first.messageId)?.payloadDigest;
  db.prepare(
    "UPDATE agent_mail SET attempts='bad',retry_at='bad' WHERE id=?",
  ).run(first.messageId);
  const second = sendMail(secondSource.run, "healthy-projection", {
    to: remote(),
    body: "Healthy outgoing mail",
  });
  const drain = drainer();
  await drain.drain();
  for (const message of [first.messageId, second.messageId]) {
    expect(
      db.prepare("SELECT state FROM agent_mail WHERE id=?").get(message),
    ).toEqual({ state: "sent" });
    expect(
      db
        .prepare(
          "SELECT projection_pending FROM fleet_mail_records WHERE mail_id=?",
        )
        .get(message),
    ).toEqual({ projection_pending: 0 });
  }
  expect(journal.outgoing(first.messageId)?.payloadDigest).toBe(digest);
  expect(
    db
      .prepare("SELECT attempts,retry_at FROM agent_mail WHERE id=?")
      .get(first.messageId),
  ).toEqual({ attempts: "bad", retry_at: "bad" });
  expect(visible(firstSource.agent.id).status).toBe("queued");
});

it("recovers receipt projection after restart and keeps unchanged receipt polls quiet", async () => {
  const { agent, run } = source();
  const first = sendMail(run, "quiet-receipt", {
    to: remote(),
    body: "Track actual delivery changes",
  });
  // Stop after the signed receipt is durable, before the drainer projects it.
  // A replacement drainer must repair that gap even if the receipt is unchanged.
  const peer = new FleetPeerMail(authority, leases, owner, journal, transport);
  try {
    await peer.deliver(first.messageId, (envelope) =>
      authorizeFleetMailSender(owner, envelope),
    );
  } finally {
    peer.close();
  }
  expect(journal.outgoing(first.messageId)?.state).toBe("accepted");
  const state = () =>
    db.prepare("SELECT state FROM agent_mail WHERE id=?").get(first.messageId);
  expect(state()).toEqual({ state: "pending" });
  const drain = drainer();
  await drain.drain();
  expect(state()).toEqual({ state: "sent" });
  expect(visible(agent.id).status).toBe("queued");
  const cursor = () =>
    (
      db
        .prepare("SELECT max(id) value FROM events WHERE owner_id=?")
        .get(owner) as { value: number }
    ).value;
  const activity = () =>
    db
      .prepare("SELECT updated_at FROM agent_threads WHERE id=?")
      .get(first.threadId);
  const before = { cursor: cursor(), activity: activity() };
  wake();
  await drain.drain();
  expect({ cursor: cursor(), activity: activity() }).toEqual(before);
  mode = "offline";
  wake();
  await drain.drain();
  const error = () =>
    (
      db
        .prepare("SELECT error FROM agent_mail WHERE id=?")
        .get(first.messageId) as { error: string | null }
    ).error;
  expect(error()).toMatch(/unavailable/);
  mode = "normal";
  wake();
  await drain.drain();
  expect(error()).toBeNull();
  const recovered = { cursor: cursor(), activity: activity() };
  wake();
  await drain.drain();
  expect({ cursor: cursor(), activity: activity() }).toEqual(recovered);
  deliveryStatus = "handled";
  wake();
  await drain.drain();
  expect(visible(agent.id).status).toBe("handled");
  expect(cursor()).toBeGreaterThan(before.cursor);
  expect(received).toHaveLength(1);
});

it("recovers a settled receipt after restart without contacting the peer", async () => {
  const { agent, run } = source();
  const first = sendMail(run, "settled-recovery", {
    to: remote(),
    body: "Keep completed evidence after restart",
  });
  const peer = new FleetPeerMail(authority, leases, owner, journal, transport);
  try {
    await peer.deliver(first.messageId, (envelope) =>
      authorizeFleetMailSender(owner, envelope),
    );
    deliveryStatus = "handled";
    await peer.deliver(first.messageId, (envelope) =>
      authorizeFleetMailSender(owner, envelope),
    );
  } finally {
    peer.close();
  }
  expect(journal.outgoing(first.messageId)?.settled).toBe(true);
  expect(journal.unsettled()).toEqual([]);
  const state = () =>
    db.prepare("SELECT state FROM agent_mail WHERE id=?").get(first.messageId);
  expect(state()).toEqual({ state: "pending" });
  mode = "offline";
  calls.length = 0;
  const otherOwner = "other-recovery-owner";
  const otherJournal = new FleetMailJournal(db, authority, otherOwner);
  expect(
    () =>
      new FleetMailDrainer(
        authority,
        otherOwner,
        otherJournal,
        new FleetPeerMail(
          authority,
          leases,
          otherOwner,
          otherJournal,
          transport,
        ),
      ),
  ).toThrow(/no fleet grant/);
  expect(state()).toEqual({ state: "pending" });
  await drainer().drain();
  expect(state()).toEqual({ state: "sent" });
  expect(visible(agent.id).status).toBe("handled");
  expect(calls).toEqual([]);
  expect(received).toHaveLength(1);
});

it("owns autonomous delivery and tool cleanup through the companion mail service lifecycle", async () => {
  const { run } = source();
  const first = sendMail(run, "service-owned", {
    to: remote(),
    body: "no browser is needed",
  });
  disable();
  const lifecycle = new FleetMailServices(
    authority,
    credentials,
    leases,
    owner,
    secrets,
    capacity,
    transport,
  );
  try {
    expect(calls).toEqual([]);
    expect(() => assertFleetMailTools(owner)).toThrow(/unavailable/);
    expect(lifecycle.worker.sources().map((value) => value.sourceId)).toContain(
      "",
    );
    expect(lifecycle.worker.observe).toBeTypeOf("function");
    let changed = 0;
    const unobserve = lifecycle.worker.observe!(() => changed++);
    const before = authority.directory(owner)!;
    directory = authority.revise(owner, {
      mutationId: id(),
      expected: directoryDigest(before.document),
      members: before.document.members.map((member) =>
        member.machineId === authority.identity.machineId
          ? { ...member, name: "Renamed source" }
          : member,
      ),
    });
    peerAuthority.accept(peerOwner, directory);
    await Promise.resolve();
    expect(changed).toBe(1);
    expect(lifecycle.worker.sources()[0].name).toBe("Renamed source");
    unobserve();
    lifecycle.start();
    lifecycle.start();
    await expect
      .poll(() => journal.outgoing(first.messageId)?.state)
      .toBe("accepted");
    expect(received).toHaveLength(1);
    expect(received[0].messageId).toBe(first.messageId);
    expect(() => assertFleetMailTools("another-owner")).toThrow(/unavailable/);
    // A superseded service must not uninstall a later lifecycle's binding.
    disable = installFleetMailTools(owner);
    lifecycle.close();
    expect(() => assertFleetMailTools(owner)).not.toThrow();
    expect(lifecycle.worker.sources()).toEqual([]);
    expect(() =>
      lifecycle.worker.read(
        "",
        { offset: 0, limit: 20 },
        {
          runId: run.id,
          agentId: run.agent_id!,
          conversationId: run.conversation_id!,
          connectionId: run.payload.connectionId!,
          nativeGeneration: null,
        },
        () => {},
      ),
    ).toThrow(/stopped/);
    lifecycle.start();
  } finally {
    lifecycle.close();
    disable();
    disable = installFleetMailTools(owner);
  }
});

it("keeps a lost acceptance unknown across sender cancellation and drainer restart, then reads its original receipt", async () => {
  const { agent, run } = source();
  const mail = sendMail(run, "lost", { to: remote(), body: "once" });
  mode = "lost";
  const old = drainer();
  await old.drain();
  old.close();
  expect(visible(agent.id).status).toBe("unconfirmed");
  expect(visible(agent.id).remote_conversation).toBeNull();
  expect(received).toHaveLength(1);
  transition(run, "cancelled");
  mode = "normal";
  calls.length = 0;
  wake();
  await drainer().drain();
  expect(calls).toContain("/api" + fleetMailApi.receipt.path);
  expect(calls).not.toContain("/api" + fleetMailApi.accept.path);
  expect(received).toHaveLength(1);
  expect(journal.outgoing(mail.messageId)?.state).toBe("accepted");
});

it("rechecks cancellation after preparation and before the first envelope transmission", async () => {
  const { run } = source();
  const mail = sendMail(run, "between-prepare-and-send", {
    to: remote(),
    body: "cancel before body IO",
  });
  beforePreparedReply = () => transition(run, "cancelled");
  await drainer().drain();
  expect(calls).toContain("/api" + fleetMailApi.prepare.path);
  expect(calls).not.toContain("/api" + fleetMailApi.accept.path);
  expect(received).toEqual([]);
  expect(journal.outgoing(mail.messageId)).toMatchObject({
    state: "refused",
    settled: true,
  });
});

it("does not retry a prepared envelope after cancellation or falsely settle its uncertain outcome", async () => {
  const { agent, run } = source();
  const mail = sendMail(run, "cancel", { to: remote(), body: "cancel me" });
  mode = "before-accept";
  const drain = drainer();
  await drain.drain();
  transition(run, "cancelled");
  mode = "normal";
  calls.length = 0;
  wake();
  await drain.drain();
  expect(calls).toContain("/api" + fleetMailApi.receipt.path);
  expect(calls).not.toContain("/api" + fleetMailApi.accept.path);
  expect(received).toEqual([]);
  expect(journal.outgoing(mail.messageId)).toMatchObject({
    state: "unknown",
    settled: false,
  });
  expect(visible(agent.id).status).toBe("unconfirmed");
});

it.each(["cancel", "retire", "delete-conversation", "change-provider"])(
  "refuses an unsent envelope before network after %s",
  async (change) => {
    const { agent, run } = source();
    const mail = sendMail(run, "recheck", { to: remote(), body: "recheck me" });
    if (change === "cancel") transition(run, "cancelled");
    if (change === "retire")
      db.prepare("UPDATE agents SET retired_at=? WHERE id=?").run(
        now(),
        agent.id,
      );
    if (change === "delete-conversation")
      db.transaction(() => {
        // Retained run history releases its foreign key; mail retains the
        // original opaque conversation binding for its next dispatch check.
        db.prepare("UPDATE runs SET conversation_id=NULL WHERE id=?").run(
          run.id,
        );
        db.prepare("DELETE FROM conversations WHERE id=?").run(
          run.conversation_id,
        );
      })();
    if (change === "change-provider")
      db.prepare("UPDATE agents SET connection_id=NULL WHERE id=?").run(
        agent.id,
      );
    await drainer().drain();
    expect(calls).toEqual([]);
    expect(received).toEqual([]);
    expect(journal.outgoing(mail.messageId)).toMatchObject({
      state: "refused",
      settled: true,
    });
  },
);

it.each(["claude", "codex", "pi", "opencode", "muse", "grok", "acp"])(
  "fences an active %s generation while preserving completed mail through an idle restart",
  async (harness) => {
    const first = source(harness),
      second = source(harness);
    const stale = sendMail(first.run, "stale", { to: remote(), body: "stale" });
    const durable = sendMail(second.run, "completed", {
      to: remote(),
      body: "completed",
    });
    finishNative(second.run);
    db.prepare(
      "UPDATE companion_sessions SET generation=? WHERE conversation_id IN (?,?)",
    ).run(id(), first.run.conversation_id, second.run.conversation_id);
    await drainer().drain();
    expect(journal.outgoing(stale.messageId)?.state).toBe("refused");
    expect(journal.outgoing(durable.messageId)?.state).toBe("accepted");
    expect(received.map((mail) => mail.body)).toEqual(["completed"]);
  },
);

it.each(["sender", "resume"])(
  "rechecks %s grants after offline queuing and run completion",
  async (kind) => {
    const initiatingDb = new Database(":memory:");
    applyMigrations(initiatingDb);
    initiatingDb
      .prepare("INSERT INTO deployment_profile VALUES(1,'companion')")
      .run();
    const initiator = new FleetAuthority(initiatingDb, secrets);
    try {
      directory = authority.revise(owner, {
        mutationId: id(),
        expected: directoryDigest(directory.document),
        members: [
          ...directory.document.members,
          {
            ...initiator.identity,
            grantId: id(),
            name: "Initiating peer",
            origin: "https://initiator.example",
          },
        ],
      });
      peerAuthority.accept(peerOwner, directory);
      const grant = {
        fleetId: directory.document.fleetId,
        grantId: directory.document.members[0].grantId,
        destination: authority.identity.machineId,
        peer: initiator.identity.machineId,
        directory: directoryDigest(directory.document),
        operation: kind === "sender" ? ("mail" as const) : ("act" as const),
      };
      const authorized = <T>(apply: () => T) =>
        withFleetAction(
          { owner, commandId: id(), grant },
          () => authorizeFleetEffect(owner, grant),
          apply,
        );
      const { run } = kind === "sender" ? authorized(() => source()) : source();
      const to = remote();
      let threadId: string | undefined;
      if (kind === "resume") {
        const first = sendMail(run, "establish-thread", {
          to,
          body: "First message",
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        await drainer().drain();
        expect(journal.outgoing(first.messageId)?.state).toBe("accepted");
        threadId = first.threadId;
        db.prepare(
          "UPDATE agent_threads SET paused_at=?,paused_reason='fixture hold' WHERE id=?",
        ).run(now(), threadId);
        received.length = 0;
      }
      const mail = sendMail(run, "inherited-grant", {
        to,
        ...(threadId ? { threadId } : {}),
        body: "Must retain the initiating peer's grant",
      });
      mode = "offline";
      if (kind === "resume") {
        expect(mail.delivery).toBe("held");
        expect(
          authorized(() => resumeThread(owner, null, mail.threadId)),
        ).toEqual({ released: 1, refused: 0, held: 0 });
      }
      const drain = drainer();
      await drain.drain();
      expect(journal.outgoing(mail.messageId)?.state).toBe("pending");
      transition(run, "completed");
      directory = authority.revise(owner, {
        mutationId: id(),
        expected: directoryDigest(directory.document),
        members: directory.document.members.filter(
          (member) => member.machineId !== initiator.identity.machineId,
        ),
      });
      peerAuthority.accept(peerOwner, directory);
      mode = "normal";
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (kind === "resume")
        expect(() => assertFleetEffect(owner, "run", run.id)).not.toThrow();
      expect(() =>
        authorizeFleetMailSender(
          owner,
          journal.pendingEnvelope(mail.messageId)!,
        ),
      ).toThrow(/authorized/);
      calls.length = 0;
      wake();
      await drain.drain();
      expect(received).toEqual([]);
      expect(calls).not.toContain("/api" + fleetMailApi.accept.path);
      expect(journal.outgoing(mail.messageId)?.state).toBe("refused");
    } finally {
      initiatingDb.close();
    }
  },
);

it("drains explicitly released mail in order while later held mail still needs Resume", async () => {
  const { run } = source(),
    to = remote();
  const first = sendMail(run, "first", { to, body: "first" });
  const drain = drainer();
  await drain.drain();
  db.prepare(
    "UPDATE agent_threads SET paused_at=?,paused_reason='fixture hold' WHERE id=?",
  ).run(now(), first.threadId);
  const held = ["second", "third"].map((body) =>
    sendMail(run, body, { to, body, threadId: first.threadId }),
  );
  expect(resumeThread(owner, null, first.threadId)).toEqual({
    released: 1,
    refused: 0,
    held: 1,
  });
  await drain.drain();
  expect(received.map((mail) => mail.body)).toEqual(["first", "second"]);
  expect(journal.outgoing(held[1].messageId)).toBeNull();
  expect(resumeThread(owner, null, first.threadId)).toEqual({
    released: 1,
    refused: 0,
    held: 0,
  });
  await drain.drain();
  expect(received.map((mail) => mail.body)).toEqual([
    "first",
    "second",
    "third",
  ]);
});

it("leaves held mail outside the outbox until explicit Resume and retains per-run limits", async () => {
  const { agent, run } = source(),
    to = remote();
  const first = sendMail(run, "first", { to, body: "first" });
  await drainer().drain();
  db.prepare(
    "UPDATE agent_threads SET paused_at=?,paused_reason='fixture hold' WHERE id=?",
  ).run(now(), first.threadId);
  const held = sendMail(run, "held", {
    to,
    body: "held",
    threadId: first.threadId,
  });
  expect(held.delivery).toBe("held");
  expect(journal.outgoing(held.messageId)).toBeNull();
  sweepAgentMail();
  expect(journal.outgoing(held.messageId)).toBeNull();
  expect(resumeThread(owner, null, first.threadId)).toEqual({
    released: 1,
    refused: 0,
    held: 0,
  });
  expect(journal.outgoing(held.messageId)?.state).toBe("pending");
  for (let i = 0; i < 6; i++)
    sendMail(run, "quota-" + i, { to: remote(), body: "quota" });
  expect(() =>
    sendMail(run, "over-quota", { to: remote(), body: "quota" }),
  ).toThrow(/already sent 8/);
  expect(() =>
    sendMail(run, "alias", {
      to: fleetAgentAddress({
        machineId: authority.identity.machineId,
        agentId: agent.id,
      }),
      body: "self",
    }),
  ).toThrow(/yourself/);
});

it("keeps backoff after local thread deletion and never replays a lost accepted message", async () => {
  const { run } = source();
  const mail = sendMail(run, "deleted", {
    to: remote(),
    body: "already accepted",
  });
  mode = "lost";
  await drainer().drain();
  db.prepare("DELETE FROM agent_threads WHERE id=?").run(mail.threadId);
  const next = drainer();
  calls.length = 0;
  await next.drain();
  expect(calls).toEqual([]);
  mode = "normal";
  deliveryStatus = "handled";
  wake();
  await next.drain();
  expect(journal.outgoing(mail.messageId)?.settled).toBe(true);
  expect(received).toHaveLength(1);
});

it("keeps an unsent message pending after peer authentication refusal and retries its same identity", async () => {
  const { run } = source();
  const mail = sendMail(run, "auth-refused", {
    to: remote(),
    body: "keep me pending",
  });
  mode = "forbidden";
  const drain = drainer();
  await drain.drain();
  expect(journal.outgoing(mail.messageId)).toMatchObject({
    state: "pending",
    settled: false,
  });
  mode = "normal";
  wake();
  await drain.drain();
  expect(journal.outgoing(mail.messageId)?.state).toBe("accepted");
  expect(received.map((item) => item.messageId)).toEqual([mail.messageId]);
});

it("captures an authorized publication by immutable source, content and message identity before network IO", () => {
  const { run } = source();
  const bytes = Buffer.from("PRIVATE_PUBLISHED_MAIL_CONTENT");
  const published = storePublishedFile(run, "mail-publication", {
    name: "design.txt",
    title: "Design",
    mime: "text/plain",
    bytes,
  });
  const sent = sendMail(run, "with-publication", {
    to: remote(),
    body: "Read the authorized design",
    fileIds: [published.artifactId],
  });
  const envelope = journal.pendingEnvelope(sent.messageId)!;
  expect(envelope.files).toEqual([
    {
      source: authority.identity.machineId,
      fileId: published.artifactId,
      digest: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      name: "design.txt",
      mediaType: "text/plain",
    },
  ]);
  expect(JSON.stringify(envelope)).not.toContain(dir);
  expect(JSON.stringify(envelope)).not.toContain(bytes.toString());
  expect(outgoingFleetMailFile(owner, envelope, published.artifactId)).toEqual(
    bytes,
  );
  expect(() =>
    outgoingFleetMailFile("foreign-owner", envelope, published.artifactId),
  ).toThrow();
  expect(() =>
    outgoingFleetMailFile(
      owner,
      { ...envelope, body: "forged payload" },
      published.artifactId,
    ),
  ).toThrow();
  expect(calls).toEqual([]);
});

it("forwards only an attached local copy and rejects changed bytes against the captured descriptor", () => {
  const { run } = source();
  const bytes = randomBytes(32);
  const file = uploadFile(owner, {
    originalname: "forward.bin",
    mimetype: "application/octet-stream",
    buffer: bytes,
  });
  expect(() =>
    sendMail(run, "unattached", {
      to: remote(),
      body: "Unavailable",
      fileIds: [file.id],
    }),
  ).toThrow(/not one you published/);
  db.prepare(
    "UPDATE messages SET metadata=? WHERE owner_id=? AND conversation_id=?",
  ).run(JSON.stringify({ attachments: [file] }), owner, run.conversation_id);
  const sent = sendMail(run, "attached", {
    to: remote(),
    body: "Authorized local copy",
    fileIds: [file.id],
  });
  const envelope = journal.pendingEnvelope(sent.messageId)!;
  expect(envelope.files[0].source).toBe(authority.identity.machineId);
  expect(outgoingFleetMailFile(owner, envelope, file.id)).toEqual(bytes);
  db.prepare("UPDATE objects SET bytes=? WHERE id=? AND owner_id=?").run(
    Buffer.alloc(32),
    file.objectId,
    owner,
  );
  expect(() => outgoingFleetMailFile(owner, envelope, file.id)).toThrow(
    /unavailable or changed/,
  );
  const foreign = uploadFile("foreign-owner", {
    originalname: "private.bin",
    mimetype: "application/octet-stream",
    buffer: bytes,
  });
  expect(() =>
    sendMail(run, "foreign", {
      to: remote(),
      body: "Unavailable",
      fileIds: [foreign.id],
    }),
  ).toThrow(/not one you published/);
  expect(calls).toEqual([]);
});

it("refuses an unsent message before network when its publication is removed", async () => {
  const { run } = source();
  const file = storePublishedFile(run, "removed-publication", {
    name: "removed.txt",
    title: "Removed",
    mime: "text/plain",
    bytes: Buffer.from("Private"),
  });
  const sent = sendMail(run, "removed-file", {
    to: remote(),
    body: "Will not be transmitted",
    fileIds: [file.artifactId],
  });
  db.prepare(
    "DELETE FROM artifact_objects WHERE owner_id=? AND artifact_id=?",
  ).run(owner, file.artifactId);
  await drainer().drain();
  expect(journal.outgoing(sent.messageId)).toMatchObject({
    state: "refused",
    settled: true,
  });
  expect(
    db
      .prepare(
        "SELECT local_refusal FROM fleet_mail_outbox WHERE owner_id=? AND message_id=?",
      )
      .get(owner, sent.messageId),
  ).toEqual({ local_refusal: "files_unavailable" });
  expect(calls).toEqual([]);
});

it("does not forward a file from a cancelled mail delivery into remote context", () => {
  const sender = source(),
    recipient = source();
  const file = storePublishedFile(sender.run, "cancelled-publication", {
    name: "private.txt",
    title: "Private",
    mime: "text/plain",
    bytes: Buffer.from("Never readable"),
  });
  const sent = sendMail(sender.run, "cancelled-local", {
    to: recipient.agent.id,
    scope: "direct",
    conversationId: recipient.run.conversation_id,
    interrupt: false,
    body: "Cancelled before dispatch",
    fileIds: [file.artifactId],
  });
  const row = db
    .prepare("SELECT run_id FROM agent_mail WHERE id=? AND owner_id=?")
    .get(sent.messageId, owner) as { run_id: string };
  transition(ownedRun(row.run_id, owner), "cancelled");
  expect(() =>
    sendMail(recipient.run, "forward-cancelled", {
      to: remote(),
      body: "Cannot forward unreadable mail",
      fileIds: [file.artifactId],
    }),
  ).toThrow(/not one you published/);
  expect(calls).toEqual([]);
});

it("parks offline mail and sends the same durable identity after signed address repair", async () => {
  const { run } = source();
  const mail = sendMail(run, "repair", { to: remote(), body: "same intent" });
  const digest = journal.outgoing(mail.messageId)!.payloadDigest;
  mode = "offline";
  const old = drainer();
  await old.drain();
  old.close();
  expect(journal.outgoing(mail.messageId)?.state).toBe("pending");
  origin = "https://repaired.example";
  host.setOrigin(origin);
  directory = authority.revise(owner, {
    mutationId: id(),
    expected: directoryDigest(directory.document),
    members: directory.document.members.map((member) =>
      member.machineId === peerAuthority.identity.machineId
        ? { ...member, origin }
        : member,
    ),
  });
  peerAuthority.accept(peerOwner, directory);
  mode = "normal";
  wake();
  await drainer().drain();
  expect(journal.outgoing(mail.messageId)).toMatchObject({
    state: "accepted",
    payloadDigest: digest,
  });
  expect(received.map((item) => item.messageId)).toEqual([mail.messageId]);
});
