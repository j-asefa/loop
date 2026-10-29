import { afterAll, afterEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations } from "../src/server/migrations.js";
import { FleetAuthority } from "../src/server/fleet-authority.js";
import { FleetCredentials } from "../src/server/fleet-credentials.js";
import {
  FleetCredentialLease,
  type FleetCredentialTransport,
} from "../src/server/fleet-credential-lease.js";
import { directoryDigest } from "../src/server/fleet-crypto.js";
import { FleetCredentialLeases } from "../src/server/fleet-credential-leases.js";
import { FleetDirectoryReconcile } from "../src/server/fleet-directory-reconcile.js";
import { FleetDirectorySync } from "../src/server/fleet-directory-sync.js";
import { Problem } from "../src/shared/problem.js";
import type { FleetCredentialProof } from "../src/shared/fleet-credentials.js";
import { FLEET_CREDENTIAL_LIFETIME_MS as TTL } from "../src/shared/fleet-credentials.js";

const root = mkdtempSync(join(tmpdir(), "loop-fleet-renewal-"));
process.env.LOOP_PROFILE = "companion";
process.env.LOOP_DATA_DIR = root;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const secrets = await import("../src/server/secrets.js");
const databases: Database.Database[] = [];
const leases: { close(): void }[] = [];
afterEach(() => {
  for (const lease of leases.splice(0)) lease.close();
  vi.useRealTimers();
});
afterAll(() => {
  for (const db of databases) if (db.open) db.close();
  rmSync(root, { recursive: true, force: true });
});
const scope = ["read", "act", "events", "mail", "files"] as const;

it("replaces a refused issuer credential without replaying work or discarding a later replacement", async () => {
  const { a, b, lease, calls } = fixture();
  const old = await lease.get();
  b.credentials = new FleetCredentials(b.db, b.authority, secrets, b.clock);
  expect(() => b.credentials.authenticate(old.token)).toThrow("invalid");
  lease.rejected(old.token);
  await expect(lease.get()).rejects.toMatchObject({ status: 503 });
  await vi.advanceTimersByTimeAsync(1_000);
  const current = await lease.get();
  expect(current.token).not.toBe(old.token);
  expect(b.credentials.authenticate(current.token).context.peer).toBe(
    a.authority.identity.machineId,
  );
  lease.rejected(old.token);
  expect((await lease.get()).token).toBe(current.token);
  expect(calls.issue).toBe(2);
});

function fixture(random = 0.5) {
  vi.useFakeTimers();
  const started = Date.now();
  function machine(wall: number) {
    const db = new Database(join(root, randomUUID() + ".db")),
      owner = randomUUID();
    databases.push(db);
    applyMigrations(db);
    db.prepare("INSERT INTO deployment_profile VALUES(1,'companion')").run();
    const authority = new FleetAuthority(db, secrets),
      offset = { mono: 0 };
    const clock = {
      wall: () => wall + Date.now() - started,
      monotonic: () => Date.now() - started + offset.mono,
    };
    const credentials = new FleetCredentials(db, authority, secrets, clock);
    return { db, owner, authority, credentials, clock, offset };
  }
  const a = machine(1_000_000),
    b = machine(9_000_000_000);
  const initial = a.authority.create(a.owner, {
    mutationId: randomUUID(),
    name: "Same name",
    origin: "https://a.example",
    scope: [...scope],
  });
  const directory = a.authority.revise(a.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(initial.document),
    members: [
      ...initial.document.members,
      {
        ...b.authority.identity,
        grantId: randomUUID(),
        name: "Same name",
        origin: "https://b.example",
      },
    ],
  });
  const grant = directory.document.members.find(
    (m) => m.machineId === b.authority.identity.machineId,
  )!;
  b.authority.approve(b.owner, {
    mutationId: randomUUID(),
    expected: null,
    kind: "enroll",
    grantId: grant.grantId,
    scope: [...scope],
    controller: a.authority.identity,
    directory,
  });
  const calls = { challenge: 0, issue: 0, nonces: [] as string[] };
  const controls: {
    failure?: "before" | "after";
    issueWait?: Promise<void>;
    challengeWait?: Promise<void>;
    wrongOperation?: boolean;
  } = {};
  const transport: FleetCredentialTransport = {
    async challenge(origin, context) {
      calls.challenge++;
      expect(origin).toBe(
        b.authority
          .directory(b.owner)!
          .document.members.find(
            (m) => m.machineId === b.authority.identity.machineId,
          )!.origin,
      );
      if (controls.failure === "before")
        throw new Error("Fixture connection unavailable");
      const response = b.credentials.challenge(
        controls.wrongOperation ? { ...context, operation: "act" } : context,
      );
      await controls.challengeWait;
      return response;
    },
    async issue(_origin, proof) {
      calls.issue++;
      calls.nonces.push(proof.challenge.challenge.nonce);
      const response = b.credentials.issue(proof);
      await controls.issueWait;
      if (controls.failure === "after")
        throw new Error("Fixture lost the issuance response");
      return response;
    },
  };
  let changes = 0;
  const lease = new FleetCredentialLease(
    a.authority,
    a.credentials,
    a.owner,
    b.authority.identity.machineId,
    "read",
    transport,
    {
      monotonic: a.clock.monotonic,
      random: () => random,
      onChange: () => changes++,
    },
  );
  leases.push(lease);
  return {
    machine,
    a,
    b,
    calls,
    controls,
    transport,
    lease,
    directory,
    changes: () => changes,
  };
}
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it("shares concurrent acquisition, validates the destination owner and keeps credential fields out of status", async () => {
  const f = fixture();
  const results = await Promise.all(
    Array.from({ length: 20 }, () => f.lease.get()),
  );
  expect(new Set(results.map((r) => r.token)).size).toBe(1);
  expect(f.calls).toMatchObject({ challenge: 1, issue: 1 });
  expect(f.b.credentials.authenticate(results[0].token)).toMatchObject({
    owner: f.b.owner,
    remainingMs: TTL,
  });
  expect(f.a.owner).not.toBe(f.b.owner);
  expect(f.lease.status()).toEqual({ state: "valid", remainingMs: TTL });
  expect(JSON.stringify(f.lease.status())).not.toContain(results[0].token);
  const wrongOwner = new FleetCredentialLease(
    f.a.authority,
    f.a.credentials,
    "another-owner",
    f.b.authority.identity.machineId,
    "read",
    f.transport,
  );
  leases.push(wrongOwner);
  await expect(wrongOwner.get()).rejects.toThrow("closed");
  expect(f.calls.issue).toBe(1);
});

it("recovers a refused renewal from another replica while the controller is unreachable", async () => {
  const f = fixture(),
    c = f.machine(4_000_000);
  const enrolled = f.a.authority.revise(f.a.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(f.directory.document),
    members: [
      ...f.directory.document.members,
      {
        ...c.authority.identity,
        grantId: randomUUID(),
        name: "Replica C",
        origin: "https://c.example",
      },
    ],
  });
  f.b.authority.accept(f.b.owner, enrolled);
  const grant = enrolled.document.members.find(
    (m) => m.machineId === c.authority.identity.machineId,
  )!;
  c.authority.approve(c.owner, {
    mutationId: randomUUID(),
    expected: null,
    kind: "enroll",
    grantId: grant.grantId,
    scope: [...scope],
    controller: f.a.authority.identity,
    directory: enrolled,
  });
  const newer = f.a.authority.revise(f.a.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(enrolled.document),
    members: enrolled.document.members,
  });
  c.authority.accept(c.owner, newer);
  const reads: string[] = [],
    sync = new FleetDirectorySync(c.db, c.authority, c.owner, secrets);
  const reconcile = new FleetDirectoryReconcile(
    f.b.db,
    f.b.authority,
    f.b.owner,
    secrets,
    {
      async history(origin, query) {
        reads.push(origin);
        if (origin === "https://a.example")
          throw new Problem(503, "Fixture controller offline");
        expect(origin).toBe("https://c.example");
        return sync.history(query);
      },
    },
  );
  leases.push(reconcile);
  let issued = 0;
  const registry = new FleetCredentialLeases(
    f.b.authority,
    f.b.credentials,
    f.b.owner,
    {
      async challenge(_origin, context) {
        return c.credentials.challenge(context);
      },
      async issue(_origin, proof) {
        issued++;
        return c.credentials.issue(proof);
      },
    },
    () => {},
    {
      monotonic: f.b.clock.monotonic,
      random: () => 0,
      reconcile: () => reconcile.any(),
    },
  );
  leases.push(registry);
  await expect(
    registry.get(c.authority.identity.machineId, "read"),
  ).rejects.toThrow("unavailable");
  await vi.advanceTimersByTimeAsync(0);
  const credential = await registry.get(c.authority.identity.machineId, "read");
  expect(reads).toEqual(["https://a.example", "https://c.example"]);
  expect(credential.context.directory).toBe(directoryDigest(newer.document));
  expect(c.credentials.authenticate(credential.token).owner).toBe(c.owner);
  expect(issued).toBe(1);
});

it("coalesces refusal recovery across operation leases and bounds repeated history reads", async () => {
  const f = fixture(),
    pending = deferred();
  let refreshes = 0;
  const registry = new FleetCredentialLeases(
    f.a.authority,
    f.a.credentials,
    f.a.owner,
    {
      async challenge() {
        throw new Problem(403, "Fixture stale head");
      },
      async issue() {
        throw new Error("Must not issue without a challenge");
      },
    },
    () => {},
    {
      monotonic: f.a.clock.monotonic,
      random: () => 0,
      reconcile: async () => {
        refreshes++;
        await pending.promise;
      },
    },
  );
  leases.push(registry);
  await Promise.all(
    scope.map((operation) =>
      registry.get(f.b.authority.identity.machineId, operation).catch(() => {}),
    ),
  );
  expect(refreshes).toBe(1);
  pending.release();
  await vi.advanceTimersByTimeAsync(29_999);
  expect(refreshes).toBe(1);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(refreshes).toBe(2);
  registry.close();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(refreshes).toBe(2);
});

it("renews from two minutes before expiry with local elapsed time and no browser or controller request", async () => {
  const f = fixture(0),
    first = await f.lease.get();
  await vi.advanceTimersByTimeAsync(480_000 - 1);
  expect(f.calls.issue).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.calls.issue).toBe(2);
  const second = await f.lease.get();
  expect(second.token).not.toBe(first.token);
  await vi.advanceTimersByTimeAsync(TTL + 1);
  const latest = await f.lease.get();
  expect(f.b.credentials.authenticate(latest.token).owner).toBe(f.b.owner);
  expect(() => f.b.credentials.authenticate(first.token)).toThrow("expired");
  expect(f.calls.challenge).toBe(f.calls.issue);
});

it("uses a fresh challenge after an uncertain issuance instead of replaying the old proof", async () => {
  const f = fixture();
  f.controls.failure = "after";
  await expect(f.lease.get()).rejects.toThrow("unavailable");
  expect(f.calls.issue).toBe(1);
  expect(
    f.b.db.prepare("SELECT count(*) n FROM fleet_credentials").get(),
  ).toEqual({ n: 1 });
  f.controls.failure = undefined;
  await vi.advanceTimersByTimeAsync(999);
  expect(f.calls.issue).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  const credential = await f.lease.get();
  expect(f.calls.issue).toBe(2);
  expect(new Set(f.calls.nonces).size).toBe(2);
  expect(f.b.credentials.authenticate(credential.token).owner).toBe(f.b.owner);
});

it("keeps a valid lease during failed renewal but expires it without extending the deadline", async () => {
  const f = fixture(),
    first = await f.lease.get();
  f.controls.failure = "before";
  await vi.advanceTimersByTimeAsync(472_500);
  expect((await f.lease.get()).token).toBe(first.token);
  expect(f.lease.status().remainingMs).toBe(127_500);
  await vi.advanceTimersByTimeAsync(127_500);
  expect(f.lease.status()).toEqual({ state: "unavailable", remainingMs: 0 });
  await expect(f.lease.get()).rejects.toThrow("unavailable");
  expect(() => f.b.credentials.authenticate(first.token)).toThrow("expired");
  expect(f.changes()).toBeGreaterThan(1);
  expect(f.calls.challenge).toBeLessThan(15);
});

it("subtracts response latency instead of resetting a destination-issued lifetime on arrival", async () => {
  const f = fixture(),
    wait = deferred();
  f.controls.issueWait = wait.promise;
  const pending = f.lease.get();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.calls.issue).toBe(1);
  await vi.advanceTimersByTimeAsync(2_000);
  wait.release();
  const accepted = await pending;
  expect(accepted.remainingMs).toBe(TTL - 2_000);
  expect(accepted.expiresAtMonotonic).toBe(TTL);
});

it("closes on known removal and ignores the old challenge callback before issuance", async () => {
  const f = fixture(),
    wait = deferred();
  f.controls.challengeWait = wait.promise;
  const pending = f.lease.get().catch((error) => error);
  await vi.advanceTimersByTimeAsync(0);
  f.a.authority.revise(f.a.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(f.directory.document),
    members: f.directory.document.members.filter(
      (m) => m.machineId !== f.b.authority.identity.machineId,
    ),
  });
  f.lease.changed();
  wait.release();
  expect(await pending).toBeInstanceOf(Error);
  expect(f.calls.issue).toBe(0);
  expect(f.lease.status().state).toBe("closed");
  await expect(f.lease.get()).rejects.toThrow("closed");
});

it("does not install a late response from the old address after a canonical repair", async () => {
  const f = fixture(),
    wait = deferred();
  f.controls.issueWait = wait.promise;
  const old = f.lease.get().catch((error) => error);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.calls.issue).toBe(1);
  const repaired = f.a.authority.revise(f.a.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(f.directory.document),
    members: f.directory.document.members.map((m) =>
      m.machineId === f.b.authority.identity.machineId
        ? { ...m, origin: "https://b-new.example" }
        : m,
    ),
  });
  f.b.authority.accept(f.b.owner, repaired);
  f.controls.issueWait = undefined;
  f.lease.changed();
  wait.release();
  expect(await old).toBeInstanceOf(Error);
  const current = await f.lease.get();
  expect(current.context.directory).toBe(directoryDigest(repaired.document));
  expect(f.calls.issue).toBe(2);
  expect(f.b.credentials.authenticate(current.token).context).toEqual(
    current.context,
  );
});

it("refuses a correctly signed challenge for a different requested operation", async () => {
  const f = fixture();
  f.controls.wrongOperation = true;
  await expect(f.lease.get()).rejects.toThrow("unavailable");
  expect(f.calls.issue).toBe(0);
});

it("bounds unresponsive transport and stops renewal after close", async () => {
  const f = fixture();
  let signal: AbortSignal | undefined;
  f.transport.challenge = async (_origin, _context, input) => {
    signal = input;
    return new Promise(() => {});
  };
  const pending = f.lease.get().catch((error) => error);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await pending).toBeInstanceOf(Error);
  expect(signal?.aborted).toBe(true);
  f.lease.close();
  expect(f.lease.status().state).toBe("closed");
  expect(vi.getTimerCount()).toBe(0);
  await expect(f.lease.get()).rejects.toThrow("closed");
});

it("fails closed when its local monotonic clock moves backward", async () => {
  const f = fixture();
  await f.lease.get();
  f.a.offset.mono = -1;
  await expect(f.lease.get()).rejects.toThrow("unavailable");
  expect(f.lease.status()).toEqual({ state: "closed", remainingMs: 0 });
  expect(vi.getTimerCount()).toBe(0);
});

it("shares registry demand per operation and renews independent server-owned leases without exposing tokens in status", async () => {
  const f = fixture(),
    peer = f.b.authority.identity.machineId,
    notices: string[] = [];
  const registry = new FleetCredentialLeases(
    f.a.authority,
    f.a.credentials,
    f.a.owner,
    f.transport,
    (id) => notices.push(id),
    { monotonic: f.a.clock.monotonic, random: () => 0 },
  );
  leases.push(registry);
  expect(registry.status(peer)).toEqual([]);
  expect(f.calls.issue).toBe(0);
  const reads = await Promise.all(
    Array.from({ length: 20 }, () => registry.get(peer, "read")),
  );
  const mail = await registry.get(peer, "mail");
  expect(new Set(reads.map((value) => value.token)).size).toBe(1);
  expect(mail.token).not.toBe(reads[0].token);
  expect(f.calls.issue).toBe(2);
  await vi.advanceTimersByTimeAsync(TTL + 1_000);
  const refreshed = await registry.get(peer, "read");
  expect(refreshed.token).not.toBe(reads[0].token);
  expect(f.calls.issue).toBe(4);
  expect(() => f.b.credentials.authenticate(reads[0].token)).toThrow();
  expect(f.b.credentials.authenticate(refreshed.token).owner).toBe(f.b.owner);
  expect(registry.status(peer)).toHaveLength(2);
  expect(JSON.stringify(registry.status(peer))).not.toContain(refreshed.token);
  expect(notices.every((value) => value === peer)).toBe(true);
  expect(() => registry.get(f.a.authority.identity.machineId, "read")).toThrow(
    "not available",
  );
  expect(() => registry.get("m_" + "f".repeat(64), "read")).toThrow(
    "not available",
  );
  expect(() => registry.get(peer, "admin" as never)).toThrow();
  expect(f.calls.issue).toBe(4);
  registry.close();
  expect(registry.status(peer)).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

it("observes committed removal and aborts registry acquisition before a proof can be sent", async () => {
  const f = fixture(),
    wait = deferred(),
    peer = f.b.authority.identity.machineId;
  const registry = new FleetCredentialLeases(
    f.a.authority,
    f.a.credentials,
    f.a.owner,
    f.transport,
    () => {},
    { monotonic: f.a.clock.monotonic, random: () => 0 },
  );
  leases.push(registry);
  f.controls.challengeWait = wait.promise;
  const pending = registry.get(peer, "read").catch((error) => error);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.calls.challenge).toBe(1);
  f.a.authority.revise(f.a.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(f.directory.document),
    members: f.directory.document.members.filter(
      (member) => member.machineId !== peer,
    ),
  });
  await vi.advanceTimersByTimeAsync(0);
  wait.release();
  expect(await pending).toBeInstanceOf(Error);
  expect(f.calls.issue).toBe(0);
  expect(registry.status(peer)).toEqual([]);
  expect(() => registry.get(peer, "read")).toThrow("not available");
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps leases through an outer rollback and observes the committed replacement without an HTTP callback", async () => {
  const f = fixture(),
    peer = f.b.authority.identity.machineId;
  const registry = new FleetCredentialLeases(
    f.a.authority,
    f.a.credentials,
    f.a.owner,
    f.transport,
    () => {},
    { monotonic: f.a.clock.monotonic, random: () => 0 },
  );
  leases.push(registry);
  const first = await registry.get(peer, "read");
  const remove = () =>
    f.a.authority.revise(f.a.owner, {
      mutationId: randomUUID(),
      expected: directoryDigest(f.directory.document),
      members: f.directory.document.members.filter(
        (member) => member.machineId !== peer,
      ),
    });
  expect(() =>
    f.a.db.transaction(() => {
      remove();
      throw new Error("Fixture outer rollback");
    })(),
  ).toThrow("Fixture outer rollback");
  await vi.advanceTimersByTimeAsync(0);
  expect((await registry.get(peer, "read")).token).toBe(first.token);
  expect(f.calls.issue).toBe(1);
  const repaired = f.a.authority.revise(f.a.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(f.directory.document),
    members: f.directory.document.members.map((member) =>
      member.machineId === peer
        ? { ...member, origin: "https://b-new.example" }
        : member,
    ),
  });
  f.b.authority.accept(f.b.owner, repaired);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.calls.issue).toBe(2);
  expect((await registry.get(peer, "read")).context.directory).toBe(
    directoryDigest(repaired.document),
  );
  expect(() => f.b.credentials.authenticate(first.token)).toThrow();
});
