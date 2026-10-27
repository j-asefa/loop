import { afterAll, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { applyMigrations } from "../src/server/migrations.js";
import { FleetAuthority } from "../src/server/fleet-authority.js";
import { FleetPairing } from "../src/server/fleet-pairing.js";
import { FleetEnrollmentDestination } from "../src/server/fleet-enrollment.js";
import { FleetProof, verifyFleetProof } from "../src/server/fleet-proof.js";
import {
  directoryDigest,
  fleetPayloadDigest,
} from "../src/server/fleet-crypto.js";
import {
  fleetDeviceFromLink,
  fleetEnrollmentFromLink,
} from "../src/shared/fleet-pairing.js";
import {
  FleetEnrollmentIntent,
  type SignedFleetEnrollmentCommit,
  type SignedFleetPreparedEnrollment,
} from "../src/shared/fleet-enrollment.js";
import type {
  FleetOperation,
  SignedFleetDirectory,
} from "../src/shared/fleet.js";

const root = mkdtempSync(join(tmpdir(), "loop-fleet-enrollment-"));
process.env.LOOP_PROFILE = "companion";
process.env.LOOP_DATA_DIR = root;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const secrets = await import("../src/server/secrets.js");
const databases: Database.Database[] = [];
const scope: FleetOperation[] = ["read", "act", "events", "mail", "files"];
afterAll(() => {
  for (const db of databases) if (db.open) db.close();
  rmSync(root, { recursive: true, force: true });
});
function machine(
  options: { owner?: string; dir?: string; origin?: string; now?: number } = {},
) {
  const owner = options.owner ?? randomUUID(),
    dir = options.dir ?? join(root, randomUUID());
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "workspace.db"));
  databases.push(db);
  db.pragma("foreign_keys=ON");
  applyMigrations(db);
  db.prepare(
    "INSERT OR IGNORE INTO deployment_profile VALUES(1,'companion')",
  ).run();
  const state = {
    origin: options.origin ?? `https://${randomUUID()}.example`,
    now: options.now ?? 1_000_000,
  };
  const authority = new FleetAuthority(db, secrets),
    pairing = new FleetPairing(db, authority, owner, dir, () => state.now);
  const proof = new FleetProof(db, authority.identity, secrets);
  const destination = new FleetEnrollmentDestination(
    db,
    authority,
    pairing,
    owner,
    secrets,
    () => state.origin,
  );
  return { owner, dir, db, state, authority, pairing, proof, destination };
}
type Machine = ReturnType<typeof machine>;
function request(
  a: Machine,
  b: Machine,
  mode: FleetEnrollmentIntent["mode"] = "enroll",
  granted: FleetOperation[] = scope,
) {
  const directory =
    a.authority.directory(a.owner) ??
    a.authority.create(a.owner, {
      mutationId: randomUUID(),
      name: "Same label",
      origin: a.state.origin,
      scope,
    });
  const { url } =
    mode === "enroll" && granted === scope
      ? b.pairing.pair(b.state.origin)
      : b.pairing.enrollment(b.state.origin, granted, mode === "recover");
  const link = fleetEnrollmentFromLink(url);
  const intent = FleetEnrollmentIntent.parse({
    version: 1,
    operationId: randomUUID(),
    ceremonyId: link.ceremonyId,
    capabilityHash: createHash("sha256").update(link.enrollment).digest("hex"),
    destination: link.machine,
    origin: link.origin,
    name: "Same label",
    mode,
    scope: granted,
    directory,
  });
  return {
    url,
    intent,
    signature: a.proof.sign("enrollment-prepare", intent),
    capability: link.enrollment,
  };
}
type Request = ReturnType<typeof request>;
const wire = ({ url: _, ...value }: Request) => value;
function commit(
  a: Machine,
  input: Request,
  prepared: SignedFleetPreparedEnrollment,
  ancestors: SignedFleetDirectory[] = [],
): SignedFleetEnrollmentCommit {
  const original = input.intent.directory.document;
  const members = original.members.some(
    (member) => member.machineId === prepared.prepared.member.machineId,
  )
    ? original.members.map((member) =>
        member.machineId === prepared.prepared.member.machineId
          ? prepared.prepared.member
          : member,
      )
    : [...original.members, prepared.prepared.member];
  const directory = a.authority.revise(a.owner, {
    mutationId: input.intent.operationId,
    expected: directoryDigest(original),
    members,
  });
  const value = {
    version: 1 as const,
    operationId: input.intent.operationId,
    intentDigest: fleetPayloadDigest(input.intent),
    directory,
    ancestors,
  };
  return { commit: value, signature: a.proof.sign("enrollment-commit", value) };
}
function query(a: Machine, input: Request) {
  const value = {
    version: 1 as const,
    operationId: input.intent.operationId,
    intentDigest: fleetPayloadDigest(input.intent),
    destination: input.intent.destination,
  };
  return { query: value, signature: a.proof.sign("enrollment-query", value) };
}
function enroll(a: Machine, b: Machine) {
  const input = request(a, b),
    prepared = b.destination.prepare(wire(input)),
    committed = commit(a, input, prepared);
  b.destination.commit(committed);
  return { input, prepared, committed };
}

it("proves the exact destination origin and fresh nonce without a capability or local owner", () => {
  const b = machine(),
    c = machine();
  const probe = {
    version: 1 as const,
    nonce: randomBytes(32).toString("base64url"),
    origin: b.state.origin,
    destination: b.authority.identity,
  };
  const response = b.destination.probe(probe);
  expect(response.probe).toEqual(probe);
  expect(
    verifyFleetProof(
      b.authority.identity,
      "enrollment-probe",
      response.probe,
      response.signature,
    ),
  ).toBe(true);
  expect(
    verifyFleetProof(
      b.authority.identity,
      "enrollment-probe",
      { ...probe, nonce: randomBytes(32).toString("base64url") },
      response.signature,
    ),
  ).toBe(false);
  expect(
    verifyFleetProof(
      b.authority.identity,
      "enrollment-query",
      probe,
      response.signature,
    ),
  ).toBe(false);
  expect(() => c.destination.probe(probe)).toThrow("invalid");
  expect(() =>
    b.destination.probe({ ...probe, origin: c.state.origin }),
  ).toThrow("invalid");
  expect(JSON.stringify(response)).not.toContain(b.owner);
});

it("atomically binds a pending enrollment, consumes both capabilities and activates only the committed directory", () => {
  const a = machine(),
    b = machine(),
    input = request(a, b);
  const prepared = b.destination.prepare(wire(input));
  expect(a.owner).not.toBe(b.owner);
  expect(b.authority.status(b.owner).state).toBe("standalone");
  expect(
    b.db.prepare("SELECT count(*) n FROM fleet_peer_grants").get(),
  ).toEqual({ n: 0 });
  expect(() =>
    b.pairing.redeem(
      { ...fleetDeviceFromLink(input.url, b.state.origin), name: "Phone" },
      b.state.origin,
    ),
  ).toThrow("used");
  expect(b.pairing.devices()).toHaveLength(0);
  const stored = JSON.stringify(
    b.db.prepare("SELECT * FROM fleet_enrollments").all(),
  );
  expect(stored).not.toContain(input.capability);
  expect(stored).not.toContain(
    fleetDeviceFromLink(input.url, b.state.origin).secret,
  );
  expect(JSON.stringify(prepared)).not.toContain(b.owner);
  const committed = commit(a, input, prepared),
    receipt = b.destination.commit(committed);
  expect(receipt.receipt.state).toBe("complete");
  expect(
    verifyFleetProof(
      b.authority.identity,
      "enrollment-receipt",
      receipt.receipt,
      receipt.signature,
    ),
  ).toBe(true);
  const head = directoryDigest(committed.commit.directory.document);
  expect(b.authority.status(b.owner).head).toBe(head);
  expect(
    b.authority.authorize({
      fleetId: committed.commit.directory.document.fleetId,
      grantId: prepared.prepared.member.grantId,
      peer: a.authority.identity.machineId,
      destination: b.authority.identity.machineId,
      directory: head,
      operation: "act",
    }).owner,
  ).toBe(b.owner);
});

it("recovers the same preparation and commit receipts after expiry and process reopen without replaying consent", () => {
  const a = machine(),
    b = machine(),
    input = request(a, b),
    prepared = b.destination.prepare(wire(input));
  b.db.close();
  const again = machine({
    owner: b.owner,
    dir: b.dir,
    origin: b.state.origin,
    now: b.state.now + 300_000,
  });
  expect(again.destination.prepare(wire(input))).toEqual(prepared);
  expect(again.destination.receipt(query(a, input)).receipt.state).toBe(
    "prepared",
  );
  const committed = commit(a, input, prepared),
    receipt = again.destination.commit(committed);
  again.db.close();
  const last = machine({
    owner: b.owner,
    dir: b.dir,
    origin: b.state.origin,
    now: b.state.now + 600_000,
  });
  expect(last.destination.commit(committed)).toEqual(receipt);
  expect(last.destination.receipt(query(a, input))).toEqual(receipt);
  expect(
    last.db
      .prepare("SELECT count(*) n FROM fleet_local_consents WHERE owner_id=?")
      .get(b.owner),
  ).toEqual({ n: 1 });
  expect(last.pairing.devices()).toHaveLength(0);
});

it("rejects substituted identities, capability halves, scope and signatures without consuming valid consent", () => {
  const a = machine(),
    b = machine(),
    c = machine(),
    input = request(a, b);
  const sign = (intent: FleetEnrollmentIntent) => ({
    intent,
    capability: input.capability,
    signature: a.proof.sign("enrollment-prepare", intent),
  });
  expect(() =>
    b.destination.prepare(
      sign({ ...input.intent, destination: c.authority.identity }),
    ),
  ).toThrow("invalid");
  expect(() =>
    b.destination.prepare(sign({ ...input.intent, origin: c.state.origin })),
  ).toThrow("invalid");
  expect(() =>
    b.destination.prepare({
      ...wire(input),
      capability: fleetDeviceFromLink(input.url, b.state.origin).secret,
    }),
  ).toThrow("invalid");
  expect(() =>
    b.destination.prepare({
      ...wire(input),
      signature: c.proof.sign("enrollment-prepare", input.intent),
    }),
  ).toThrow("invalid");
  expect(() =>
    b.destination.prepare({ ...wire(input), owner: a.owner } as never),
  ).toThrow();
  const prepared = b.destination.prepare(wire(input));
  expect(prepared.prepared.member.machineId).toBe(
    b.authority.identity.machineId,
  );
  const d = machine(),
    limited = request(a, d, "enroll", ["read"]);
  const broader = {
    ...limited.intent,
    scope: ["read", "act"] as FleetOperation[],
  };
  expect(() =>
    d.destination.prepare({
      ...wire(limited),
      intent: broader,
      signature: a.proof.sign("enrollment-prepare", broader),
    }),
  ).toThrow("invalid");
  expect(d.destination.prepare(wire(limited)).prepared.scope).toEqual(["read"]);
});

it("does not consume either capability when preparing the durable grant fails", () => {
  const a = machine(),
    b = machine(),
    input = request(a, b);
  b.db.exec(
    "CREATE TRIGGER fixture_enroll_failure BEFORE INSERT ON fleet_enrollments BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END",
  );
  expect(() => b.destination.prepare(wire(input))).toThrow(
    "fixture storage failure",
  );
  expect(
    b.db
      .prepare("SELECT state FROM fleet_pairing_ceremonies WHERE id=?")
      .get(input.intent.ceremonyId),
  ).toEqual({ state: "pending" });
  b.db.exec("DROP TRIGGER fixture_enroll_failure");
  expect(
    b.pairing.redeem(
      { ...fleetDeviceFromLink(input.url, b.state.origin), name: "Phone" },
      b.state.origin,
    ).token,
  ).toBeTruthy();
  expect(() => b.destination.prepare(wire(input))).toThrow("used");
});

it("rolls back active grants with commit failure and reconciles only authenticated matching operations", () => {
  const a = machine(),
    b = machine(),
    c = machine(),
    input = request(a, b),
    prepared = b.destination.prepare(wire(input)),
    committed = commit(a, input, prepared);
  b.db.exec(
    "CREATE TRIGGER fixture_commit_failure BEFORE UPDATE OF committed ON fleet_enrollments BEGIN SELECT RAISE(ABORT,'fixture receipt failure'); END",
  );
  expect(() => b.destination.commit(committed)).toThrow(
    "fixture receipt failure",
  );
  expect(b.authority.status(b.owner).state).toBe("standalone");
  expect(
    b.db.prepare("SELECT count(*) n FROM fleet_peer_grants").get(),
  ).toEqual({ n: 0 });
  expect(b.destination.receipt(query(a, input)).receipt.state).toBe("prepared");
  const altered = query(c, input);
  expect(() => b.destination.receipt(altered)).toThrow("invalid");
  const unknown = query(c, {
    ...input,
    intent: { ...input.intent, operationId: randomUUID() },
  });
  expect(() => b.destination.receipt(unknown)).toThrow("invalid");
  expect(() =>
    b.destination.receipt(
      query(a, {
        ...input,
        intent: { ...input.intent, name: "Different intent" },
      }),
    ),
  ).toThrow("invalid");
  b.db.exec("DROP TRIGGER fixture_commit_failure");
  expect(b.destination.commit(committed).receipt.state).toBe("complete");
});

it("rolls back destination acceptance on process death while keeping prepared capability consumption durable", () => {
  const a = machine(),
    b = machine(),
    input = request(a, b);
  const prepared = b.destination.prepare(wire(input)),
    committed = commit(a, input, prepared);
  const code = `
    import Database from 'better-sqlite3';
    import {FleetAuthority} from './src/server/fleet-authority.ts';
    import {FleetPairing} from './src/server/fleet-pairing.ts';
    import {FleetEnrollmentDestination} from './src/server/fleet-enrollment.ts';
    import * as secrets from './src/server/secrets.ts';
    const db=new Database(${JSON.stringify(join(b.dir, "workspace.db"))});
    db.pragma('foreign_keys=ON');
    const authority=new FleetAuthority(db,secrets);
    const pairing=new FleetPairing(db,authority,${JSON.stringify(b.owner)},${JSON.stringify(b.dir)},()=>${b.state.now});
    const destination=new FleetEnrollmentDestination(db,authority,pairing,${JSON.stringify(b.owner)},secrets,()=>${JSON.stringify(b.state.origin)});
    db.function('fleet_fixture_crash',()=>process.exit(17));
    db.exec("CREATE TEMP TRIGGER crash_during_consent AFTER INSERT ON fleet_local_consents BEGIN SELECT fleet_fixture_crash(); END");
    destination.commit(${JSON.stringify(committed)});
  `;
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", code],
    { env: process.env, encoding: "utf8" },
  );
  expect(child.status, child.stderr).toBe(17);
  expect(b.authority.status(b.owner).state).toBe("standalone");
  expect(
    b.db.prepare("SELECT count(*) n FROM fleet_local_consents").get(),
  ).toEqual({ n: 0 });
  expect(
    b.db.prepare("SELECT count(*) n FROM fleet_peer_grants").get(),
  ).toEqual({ n: 0 });
  expect(b.destination.receipt(query(a, input)).receipt.state).toBe("prepared");
  expect(() =>
    b.pairing.redeem(
      { ...fleetDeviceFromLink(input.url, b.state.origin), name: "Phone" },
      b.state.origin,
    ),
  ).toThrow("used");
  const accepted = b.destination.commit(committed);
  expect(b.destination.commit(committed)).toEqual(accepted);
  expect(
    b.db.prepare("SELECT count(*) n FROM fleet_local_consents").get(),
  ).toEqual({ n: 1 });
});

it("keeps cancellation durable and capabilities spent, and never reverts a completed enrollment", () => {
  const a = machine(),
    b = machine(),
    input = request(a, b),
    prepared = b.destination.prepare(wire(input));
  b.destination.cancel(input.intent.operationId);
  expect(b.destination.receipt(query(a, input)).receipt.state).toBe(
    "cancelled",
  );
  expect(() => b.destination.prepare(wire(input))).toThrow("cancelled");
  const committed = commit(a, input, prepared);
  expect(() => b.destination.commit(committed)).toThrow("cancelled");
  expect(() =>
    b.pairing.redeem(
      { ...fleetDeviceFromLink(input.url, b.state.origin), name: "Phone" },
      b.state.origin,
    ),
  ).toThrow("used");
  expect(b.authority.status(b.owner).state).toBe("standalone");
  const c = machine(),
    completed = enroll(a, c);
  expect(() =>
    c.destination.cancel(completed.input.intent.operationId),
  ).toThrow("already committed");
  expect(c.destination.receipt(query(a, completed.input)).receipt.state).toBe(
    "complete",
  );
});

it("refuses expired or rebound ceremonies and a changed local directory", () => {
  const a = machine(),
    b = machine(),
    c = machine();
  const expired = request(a, b);
  b.state.now += 120_000;
  expect(() => b.destination.prepare(wire(expired))).toThrow("expired");
  const first = request(a, b),
    prepared = b.destination.prepare(wire(first));
  const changed = { ...first.intent, operationId: randomUUID() };
  expect(() =>
    b.destination.prepare({
      ...wire(first),
      intent: changed,
      signature: a.proof.sign("enrollment-prepare", changed),
    }),
  ).toThrow("different operation");
  const second = request(c, b),
    secondPrepared = b.destination.prepare(wire(second));
  expect(() => b.destination.commit(commit(a, first, prepared))).toThrow(
    "cancelled",
  );
  b.destination.commit(commit(c, second, secondPrepared));
  expect(b.authority.directory(b.owner)?.document.controller).toEqual(
    c.authority.identity,
  );
  const d = machine(),
    changedLocal = request(c, d),
    ready = d.destination.prepare(wire(changedLocal));
  d.authority.create(d.owner, {
    mutationId: randomUUID(),
    name: "Independent fleet",
    origin: d.state.origin,
    scope,
  });
  expect(() => d.destination.commit(commit(c, changedLocal, ready))).toThrow(
    "changed after enrollment preparation",
  );
});

it("resumes a published but unconfirmed member only with fresh consent and its locally issued inactive grant", () => {
  const a = machine(),
    b = machine(),
    first = request(a, b),
    prepared = b.destination.prepare(wire(first)),
    published = commit(a, first, prepared);
  b.destination.cancel(first.intent.operationId);
  b.state.origin = "https://fresh-origin.example";
  const resumed = request(a, b, "enroll", ["read"]),
    next = b.destination.prepare(wire(resumed));
  expect(next.prepared.member.grantId).toBe(prepared.prepared.member.grantId);
  expect(next.prepared.scope).toEqual(["read"]);
  expect(b.authority.status(b.owner).state).toBe("standalone");
  expect(() => b.destination.commit(published)).toThrow("cancelled");
  const receipt = b.destination.commit(commit(a, resumed, next));
  expect(receipt.receipt.state).toBe("complete");
  expect(b.authority.directory(b.owner)?.document.members).toContainEqual(
    next.prepared.member,
  );
  expect(
    b.db.prepare("SELECT count(*) n FROM fleet_local_consents").get(),
  ).toEqual({ n: 1 });
  expect(b.db.prepare("SELECT scope FROM fleet_binding").get()).toEqual({
    scope: '["read"]',
  });
  expect(() => b.destination.commit(published)).toThrow("cancelled");

  const c = machine(),
    controller = machine();
  const seed = request(controller, c);
  controller.authority.revise(controller.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(seed.intent.directory.document),
    members: [
      ...seed.intent.directory.document.members,
      {
        ...c.authority.identity,
        grantId: next.prepared.member.grantId,
        name: "Fabricated pending grant",
        origin: c.state.origin,
      },
    ],
  });
  const fabricated = request(controller, c);
  expect(() => c.destination.prepare(wire(fabricated))).toThrow("invalid");
  expect(
    c.pairing.redeem(
      { ...fleetDeviceFromLink(fabricated.url, c.state.origin), name: "Phone" },
      c.state.origin,
    ).token,
  ).toBeTruthy();
});

it("repairs an existing address through verified missing revisions without changing its grant or identity", () => {
  const a = machine(),
    b = machine(),
    original = enroll(a, b);
  const before = b.authority.status(b.owner).head;
  const current = a.authority.directory(a.owner)!;
  const intermediate = a.authority.revise(a.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(current.document),
    members: current.document.members.map((m) =>
      m.machineId === a.authority.identity.machineId
        ? { ...m, name: "New controller label" }
        : m,
    ),
  });
  b.state.origin = "https://rotated-destination.example";
  const repair = request(a, b, "repair"),
    prepared = b.destination.prepare(wire(repair));
  expect(prepared.prepared.expectedHead).toBe(before);
  expect(prepared.prepared.member.grantId).toBe(
    original.prepared.prepared.member.grantId,
  );
  const committed = commit(a, repair, prepared);
  expect(() => b.destination.commit(committed)).toThrow("Synchronize");
  expect(b.authority.status(b.owner).head).toBe(before);
  const complete = { ...committed.commit, ancestors: [intermediate] };
  b.destination.commit({
    commit: complete,
    signature: a.proof.sign("enrollment-commit", complete),
  });
  expect(
    b.authority
      .directory(b.owner)
      ?.document.members.find(
        (m) => m.machineId === b.authority.identity.machineId,
      ),
  ).toEqual(prepared.prepared.member);
  expect(
    b.db.prepare("SELECT count(*) n FROM fleet_local_consents").get(),
  ).toEqual({ n: 1 });
  expect(b.pairing.devices()).toHaveLength(0);
});

it("requires fresh per-member recovery consent and fences the old controller only at the confirmed destination", () => {
  const old = machine(),
    next = machine(),
    b = machine();
  enroll(old, next);
  enroll(old, b);
  next.authority.accept(next.owner, old.authority.directory(old.owner)!);
  const oldHead = b.authority.status(b.owner).head;
  const oldGrant = b.authority
    .directory(b.owner)!
    .document.members.find(
      (m) => m.machineId === b.authority.identity.machineId,
    )!.grantId;
  next.authority.recover(next.owner, {
    mutationId: randomUUID(),
    expected: next.authority.status(next.owner).head!,
    name: "Recovered controller",
    origin: next.state.origin,
    scope,
  });
  const ordinary = request(next, b, "repair");
  expect(() => b.destination.prepare(wire(ordinary))).toThrow("invalid");
  expect(b.authority.status(b.owner).head).toBe(oldHead);
  const recovered = request(next, b, "recover"),
    prepared = b.destination.prepare(wire(recovered));
  expect(prepared.prepared.member.grantId).not.toBe(oldGrant);
  const publication = commit(next, recovered, prepared);
  // Before recovery completes, ordinary signed synchronization from the old
  // controller may advance B's head. It fences the old consent, but a fresh
  // ceremony can still reuse B's locally issued, never-activated recovery grant.
  const synchronized = old.authority.revise(old.owner, {
    mutationId: randomUUID(),
    expected: old.authority.status(old.owner).head!,
    members: old.authority.directory(old.owner)!.document.members,
  });
  b.authority.accept(b.owner, synchronized);
  expect(() => b.destination.commit(publication)).toThrow(
    "changed after enrollment preparation",
  );
  b.destination.cancel(recovered.intent.operationId);
  expect(() => b.destination.commit(publication)).toThrow("cancelled");
  const resumed = request(next, b, "recover"),
    resumedPreparation = b.destination.prepare(wire(resumed));
  expect(resumedPreparation.prepared.member.grantId).toBe(
    prepared.prepared.member.grantId,
  );
  expect(resumedPreparation.prepared.expectedHead).toBe(
    directoryDigest(synchronized.document),
  );
  b.destination.commit(commit(next, resumed, resumedPreparation));
  const accepted = b.authority.directory(b.owner)!;
  expect(accepted.document.controller).toEqual(next.authority.identity);
  expect(accepted.document.members.map((m) => m.machineId)).toEqual([
    next.authority.identity.machineId,
    b.authority.identity.machineId,
  ]);
  const stale = old.authority.directory(old.owner)!;
  const later = old.authority.revise(old.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(stale.document),
    members: stale.document.members,
  });
  expect(() => b.authority.accept(b.owner, later)).toThrow();
  expect(old.authority.status(old.owner).state).toBe("controller");
  expect(b.authority.directory(b.owner)).toEqual(accepted);
});

it("refuses controller substitution and unrelated membership changes in the final signed revision", () => {
  const a = machine(),
    b = machine(),
    c = machine(),
    input = request(a, b),
    prepared = b.destination.prepare(wire(input));
  const malicious = a.authority.revise(a.owner, {
    mutationId: input.intent.operationId,
    expected: directoryDigest(input.intent.directory.document),
    members: [
      ...input.intent.directory.document.members,
      prepared.prepared.member,
      {
        ...c.authority.identity,
        name: "Unexpected member",
        origin: c.state.origin,
        grantId: randomUUID(),
      },
    ],
  });
  const value = {
    version: 1 as const,
    operationId: input.intent.operationId,
    intentDigest: fleetPayloadDigest(input.intent),
    directory: malicious,
    ancestors: [],
  };
  expect(() =>
    b.destination.commit({
      commit: value,
      signature: a.proof.sign("enrollment-commit", value),
    }),
  ).toThrow("invalid");
  expect(() =>
    b.destination.commit({
      commit: value,
      signature: c.proof.sign("enrollment-commit", value),
    }),
  ).toThrow("invalid");
  expect(b.authority.status(b.owner).state).toBe("standalone");
  expect(b.destination.receipt(query(a, input)).receipt.state).toBe("prepared");
});

it("cannot turn a removed member's public directory into fresh enrollment or recovery authority", () => {
  const a = machine(),
    b = machine();
  enroll(a, b);
  const current = a.authority.directory(a.owner)!;
  const removed = a.authority.revise(a.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(current.document),
    members: current.document.members.filter(
      (m) => m.machineId !== b.authority.identity.machineId,
    ),
  });
  b.authority.accept(b.owner, removed);
  const repair = request(a, b, "repair");
  expect(() => b.destination.prepare(wire(repair))).toThrow();
  const recover = request(a, b, "recover");
  expect(() => b.destination.prepare(wire(recover))).toThrow();
  expect(b.authority.status(b.owner).state).toBe("removed");
});

it("reconciles a repair whose signed revision arrived through directory synchronization first", () => {
  const a = machine(),
    b = machine();
  enroll(a, b);
  b.state.origin = "https://synced-repair.example";
  const repair = request(a, b, "repair"),
    prepared = b.destination.prepare(wire(repair)),
    publication = commit(a, repair, prepared);
  b.authority.accept(b.owner, publication.commit.directory);
  expect(b.destination.commit(publication).receipt.state).toBe("complete");
  expect(
    b.db.prepare("SELECT count(*) n FROM fleet_local_consents").get(),
  ).toEqual({ n: 1 });

  const next = request(a, b, "repair"),
    pending = b.destination.prepare(wire(next)),
    delayed = commit(a, next, pending);
  b.authority.accept(b.owner, delayed.commit.directory);
  const removal = a.authority.revise(a.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(delayed.commit.directory.document),
    members: delayed.commit.directory.document.members.filter(
      (m) => m.machineId !== b.authority.identity.machineId,
    ),
  });
  b.authority.accept(b.owner, removal);
  expect(() => b.destination.commit(delayed)).toThrow("invalid");
  expect(b.destination.receipt(query(a, next)).receipt.state).toBe("prepared");
});

it("does not let a delayed recovery commit replace a newer prepared controller handoff", () => {
  const a = machine(),
    b = machine(),
    c = machine();
  enroll(a, b);
  enroll(a, c);
  const prior = a.authority.status(a.owner).head;
  b.authority.recover(b.owner, {
    mutationId: randomUUID(),
    expected: b.authority.status(b.owner).head!,
    name: "Recovered",
    origin: b.state.origin,
    scope,
  });
  const input = request(b, a, "recover");
  const prepared = a.destination.prepare(wire(input));
  const handoff = a.authority.prepareHandoff(a.owner, {
    mutationId: randomUUID(),
    expected: prior!,
    destination: c.authority.identity,
  });
  const committed = commit(b, input, prepared);
  expect(() => a.destination.commit(committed)).toThrow("handoff");
  expect(a.authority.status(a.owner)).toMatchObject({
    state: "handoff_pending",
    head: prior,
  });
  expect(a.destination.receipt(query(b, input)).receipt.state).toBe("prepared");
  expect(
    a.db
      .prepare("SELECT state FROM fleet_handoffs WHERE owner_id=? AND digest=?")
      .get(a.owner, directoryDigest(handoff.document)),
  ).toEqual({ state: "prepared" });
  const accepted = c.authority.acceptHandoff(c.owner, handoff);
  a.authority.accept(a.owner, accepted);
  expect(() => a.destination.commit(committed)).toThrow("directory changed");
  expect(a.authority.status(a.owner)).toMatchObject({
    state: "replica",
    head: directoryDigest(accepted.document),
  });
});

it("does not complete repair from ancestor input that includes its own revision and a later removal", () => {
  const a = machine(),
    b = machine();
  enroll(a, b);
  const prior = b.authority.status(b.owner).head;
  b.state.origin = `https://${randomUUID()}.example`;
  const input = request(a, b, "repair");
  const prepared = b.destination.prepare(wire(input));
  const repair = commit(a, input, prepared);
  const removed = a.authority.revise(a.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(repair.commit.directory.document),
    members: repair.commit.directory.document.members.filter(
      (m) => m.machineId !== b.authority.identity.machineId,
    ),
  });
  const value = {
    ...repair.commit,
    ancestors: [repair.commit.directory, removed],
  };
  const contradictory = {
    commit: value,
    signature: a.proof.sign("enrollment-commit", value),
  };
  expect(() => b.destination.commit(contradictory)).toThrow("invalid");
  expect(b.authority.status(b.owner).head).toBe(prior);
  expect(b.destination.receipt(query(a, input)).receipt.state).toBe("prepared");
  // A separate valid removal relay still fences the pending repair.
  b.authority.accept(b.owner, repair.commit.directory);
  b.authority.accept(b.owner, removed);
  expect(() => b.destination.commit(repair)).toThrow("invalid");
  expect(b.authority.status(b.owner).state).toBe("removed");
  expect(b.destination.receipt(query(a, input)).receipt.state).toBe("prepared");
});

it("binds the published directory mutation to the prepared enrollment operation", () => {
  const a = machine(),
    b = machine(),
    input = request(a, b),
    prepared = b.destination.prepare(wire(input));
  const directory = a.authority.revise(a.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(input.intent.directory.document),
    members: [
      ...input.intent.directory.document.members,
      prepared.prepared.member,
    ],
  });
  const value = {
    version: 1 as const,
    operationId: input.intent.operationId,
    intentDigest: fleetPayloadDigest(input.intent),
    directory,
    ancestors: [],
  };
  expect(() =>
    b.destination.commit({
      commit: value,
      signature: a.proof.sign("enrollment-commit", value),
    }),
  ).toThrow("invalid");
  expect(b.authority.status(b.owner).state).toBe("standalone");
  expect(
    b.db.prepare("SELECT count(*) n FROM fleet_local_consents").get(),
  ).toEqual({ n: 0 });
  expect(b.destination.receipt(query(a, input)).receipt.state).toBe("prepared");
});
