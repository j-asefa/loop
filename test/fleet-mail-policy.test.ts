import { afterAll, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetAuthority } from "../src/server/fleet-authority.js";
import { FleetMailBindings } from "../src/server/fleet-mail-bindings.js";
import { generateMachineKey } from "../src/server/fleet-crypto.js";
import { fleetAgentAddress } from "../src/shared/fleet-mail.js";

const dir = mkdtempSync(join(tmpdir(), "loop55-fleet-mail-policy-"));
process.env.LOOP55_DATA_DIR = dir;
process.env.LOOP55_PROFILE = "companion";
process.env.LOOP55_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db.js");
const secrets = await import("../src/server/secrets.js");
const { createAgent, ownedRun } = await import("../src/server/domain.js");
const { submit } = await import("../src/server/agent-runtime.js");
const { authorizeMail, normalizeMailAgentId } =
  await import("../src/server/agent-mail-policy.js");
const { sendMail } = await import("../src/server/agent-mail.js");
const owner = "local-owner";
const authority = new FleetAuthority(db, secrets);
authority.create(owner, {
  mutationId: id(),
  name: "Local machine",
  origin: "https://local.example",
  scope: ["read", "mail"],
});
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
function agent(ownerId = owner, harness?: string) {
  const connection = id();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,?,'openai','Fixture',?,'connected',?,?,?)",
  ).run(
    connection,
    ownerId,
    secrets.seal("fixture", ownerId),
    JSON.stringify([{ id: "fixture" }]),
    JSON.stringify(harness ? { loop55Harness: harness } : {}),
    now(),
  );
  return createAgent(ownerId, {
    name: "fixture-" + id().slice(0, 20),
    connectionId: connection,
    model: "fixture",
    instructions: "Isolated policy fixture",
  });
}
function conversation(ownerId: string, agentId: string) {
  return submit(ownerId, {
    agentId,
    input: "Fixture, no provider execution",
    idempotencyKey: id(),
  });
}
function fixture(harness?: string) {
  const local = agent(owner, harness);
  const run = conversation(owner, local.id);
  const peer = {
    ...generateMachineKey().identity,
    grantId: id(),
    name: "Remote machine",
    origin: "https://remote-" + id() + ".example",
  };
  const before = authority.directory(owner)!.document;
  const directory = authority.revise(owner, {
    mutationId: id(),
    expected: authority.status(owner).head!,
    members: [...before.members, peer],
  });
  // Matching UUIDs on two machines are distinct participants.
  const remote = { machineId: peer.machineId, agentId: local.id };
  const address = fleetAgentAddress(remote);
  const thread = {
    id: id(),
    owner_id: owner,
    scope: "direct" as const,
    team_id: null,
  };
  db.prepare(
    "INSERT INTO agent_threads(id,owner_id,scope,team_id,subject,created_by,created_at,updated_at) VALUES(?,?,'direct',NULL,'Fixture',?,?,?)",
  ).run(thread.id, owner, local.id, now(), now());
  db.prepare("INSERT INTO agent_thread_members VALUES(?,?,?)").run(
    thread.id,
    local.id,
    run.conversation_id,
  );
  db.prepare("INSERT INTO agent_thread_members VALUES(?,?,?)").run(
    thread.id,
    address,
    id(),
  );
  const bindings = new FleetMailBindings(db, authority, owner);
  const input = {
    threadId: thread.id,
    origin: authority.identity.machineId,
    wireThreadId: thread.id,
    localAgentId: local.id,
    remote,
    remoteName: "Remote agent",
    fleetId: directory.document.fleetId,
    localGrantId: directory.document.members.find(
      (m) => m.machineId === authority.identity.machineId,
    )!.grantId,
    peerGrantId: peer.grantId,
  };
  bindings.bind(input);
  return { local, run, peer, remote, address, thread, bindings, input };
}

it("authorizes explicit remote participants through the existing direct policy without creating agent rows", () => {
  const f = fixture();
  const before = db.prepare("SELECT count(*) n FROM agents").get();
  expect(authorizeMail(f.thread, f.local.id, f.address)).toBeUndefined();
  expect(authorizeMail(f.thread, f.address, f.local.id)).toBeUndefined();
  expect(db.prepare("SELECT count(*) n FROM agents").get()).toEqual(before);
  expect(
    new FleetMailBindings(db, authority, "other-owner").get(f.thread.id),
  ).toBeNull();
  expect(() =>
    authorizeMail(
      { ...f.thread, owner_id: "other-owner" },
      f.address,
      f.local.id,
    ),
  ).toThrow();
  expect(() => authorizeMail(f.thread, f.address, id())).toThrow();
  expect(() =>
    authorizeMail(
      { ...f.thread, scope: "team", team_id: id() },
      f.address,
      f.local.id,
    ),
  ).toThrow("team or delegation");
  expect(() => authorizeMail(f.thread, f.address, f.local.id, id())).toThrow(
    "team or delegation",
  );
});

it("keeps wire identity and participants immutable while repairing an address, and fences known removal", () => {
  const f = fixture();
  expect(
    f.bindings.bind({ ...f.input, remoteName: "Renamed remote agent" })
      .remote_name,
  ).toBe("Renamed remote agent");
  expect(f.bindings.find(f.input.origin, f.input.wireThreadId)?.thread_id).toBe(
    f.thread.id,
  );
  expect(() => f.bindings.bind({ ...f.input, wireThreadId: id() })).toThrow();
  expect(() =>
    f.bindings.bind({ ...f.input, localAgentId: agent().id }),
  ).toThrow();
  const current = authority.directory(owner)!.document;
  authority.revise(owner, {
    mutationId: id(),
    expected: authority.status(owner).head!,
    members: current.members.map((m) =>
      m.machineId === f.peer.machineId
        ? { ...m, origin: "https://repaired.example" }
        : m,
    ),
  });
  expect(authorizeMail(f.thread, f.address, f.local.id)).toBeUndefined();
  authority.revise(owner, {
    mutationId: id(),
    expected: authority.status(owner).head!,
    members: authority
      .directory(owner)!
      .document.members.filter((m) => m.machineId !== f.peer.machineId),
  });
  expect(() => authorizeMail(f.thread, f.address, f.local.id)).toThrow(
    "unavailable",
  );
  expect(() => f.bindings.bind(f.input)).toThrow("unavailable");
});

it("rechecks local recipient retirement, conversation ownership and profile at the existing policy boundary", () => {
  const f = fixture(),
    foreign = agent("other-owner"),
    foreignRun = conversation("other-owner", foreign.id);
  db.prepare(
    "UPDATE agent_thread_members SET conversation_id=? WHERE thread_id=? AND agent_id=?",
  ).run(foreignRun.conversation_id, f.thread.id, f.local.id);
  expect(() => authorizeMail(f.thread, f.address, f.local.id)).toThrow(
    "conversation",
  );
  db.prepare(
    "UPDATE agent_thread_members SET conversation_id=? WHERE thread_id=? AND agent_id=?",
  ).run(f.run.conversation_id, f.thread.id, f.local.id);
  db.prepare("UPDATE agents SET retired_at=? WHERE id=?").run(
    now(),
    f.local.id,
  );
  expect(() => authorizeMail(f.thread, f.address, f.local.id)).toThrow(
    "retired",
  );
  db.prepare("UPDATE agents SET retired_at=NULL WHERE id=?").run(f.local.id);
  db.prepare(
    "UPDATE deployment_profile SET profile='server' WHERE singleton=1",
  ).run();
  try {
    expect(() => authorizeMail(f.thread, f.address, f.local.id)).toThrow(
      "unavailable",
    );
  } finally {
    db.prepare(
      "UPDATE deployment_profile SET profile='companion' WHERE singleton=1",
    ).run();
  }
});

it.each(["claude", "codex", "pi", "opencode", "gemini", "muse", "grok", "acp"])(
  "retains local %s recipient eligibility without assuming a live-input capability",
  (harness) => {
    const f = fixture(harness);
    expect(authorizeMail(f.thread, f.address, f.local.id)).toBeUndefined();
  },
);

it("normalizes the owning machine alias before send identity, self and quota checks", () => {
  const sender = agent(),
    recipient = agent();
  const submitted = conversation(owner, sender.id);
  db.prepare("UPDATE runs SET state='running' WHERE id=?").run(submitted.id);
  const run = ownedRun(submitted.id, owner);
  const self = fleetAgentAddress({
    machineId: authority.identity.machineId,
    agentId: sender.id,
  });
  expect(normalizeMailAgentId(self)).toBe(sender.id);
  expect(() => sendMail(run, randomUUID(), { to: self, body: "Self" })).toThrow(
    "yourself",
  );
  const alias = fleetAgentAddress({
    machineId: authority.identity.machineId,
    agentId: recipient.id,
  });
  const callId = id();
  const first = sendMail(run, callId, {
    to: alias,
    body: "Same accepted message",
  });
  expect(
    sendMail(run, callId, { to: recipient.id, body: "Same accepted message" }),
  ).toEqual(first);
  expect(
    db
      .prepare("SELECT count(*) n FROM agent_mail WHERE sender_run_id=?")
      .get(run.id),
  ).toEqual({ n: 1 });
  expect(db.prepare("SELECT count(*) n FROM fleet_mail_outbox").get()).toEqual({
    n: 0,
  });
});
