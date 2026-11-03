import { afterAll, expect, it } from "vitest";
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetAuthority } from "../src/server/fleet-authority.js";
import { FleetCredentials } from "../src/server/fleet-credentials.js";
import { applyMigrations } from "../src/server/migrations.js";
import { directoryDigest } from "../src/server/fleet-crypto.js";
import {
  fleetCredentialTiming,
  FLEET_CREDENTIAL_LIFETIME_MS as TTL,
} from "../src/shared/fleet-credentials.js";
import type { FleetGrantContext, FleetOperation } from "../src/shared/fleet.js";

const root = mkdtempSync(join(tmpdir(), "loop-fleet-credentials-"));
process.env.LOOP_PROFILE = "companion";
process.env.LOOP_DATA_DIR = root;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const secrets = await import("../src/server/secrets.js");
const databases: Database.Database[] = [];
afterAll(() => {
  for (const db of databases) if (db.open) db.close();
  rmSync(root, { recursive: true, force: true });
});
const scope: FleetOperation[] = ["read", "act", "events", "mail", "files"];
function machine(
  wall = 1_000_000,
  owner = randomUUID(),
  path = join(root, randomUUID() + ".db"),
) {
  const db = new Database(path);
  databases.push(db);
  db.pragma("foreign_keys=ON");
  applyMigrations(db);
  db.prepare(
    "INSERT OR IGNORE INTO deployment_profile VALUES(1,'companion')",
  ).run();
  const authority = new FleetAuthority(db, secrets);
  const time = { wall, mono: 0 };
  const credentials = new FleetCredentials(db, authority, secrets, {
    wall: () => time.wall,
    monotonic: () => time.mono,
  });
  return { owner, path, db, authority, time, credentials };
}
type Machine = ReturnType<typeof machine>;
function advance(m: Machine, ms: number) {
  m.time.wall += ms;
  m.time.mono += ms;
}
function fleet() {
  const a = machine(1_000_000),
    b = machine(9_000_000_000),
    c = machine(500_000_000);
  const initial = a.authority.create(a.owner, {
    mutationId: randomUUID(),
    name: "A",
    origin: "https://a.example",
    scope,
  });
  const signed = a.authority.revise(a.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(initial.document),
    members: [
      ...initial.document.members,
      ...[b, c].map((m, i) => ({
        ...m.authority.identity,
        name: "Same label",
        origin: `https://${i === 0 ? "b" : "c"}.example`,
        grantId: randomUUID(),
      })),
    ],
  });
  for (const m of [b, c])
    m.authority.approve(m.owner, {
      mutationId: randomUUID(),
      expected: null,
      kind: "enroll",
      scope,
      controller: a.authority.identity,
      directory: signed,
      grantId: signed.document.members.find(
        (p) => p.machineId === m.authority.identity.machineId,
      )!.grantId,
    });
  return { a, b, c, signed };
}
function context(
  destination: Machine,
  peer: Machine,
  operation: FleetOperation = "read",
): FleetGrantContext {
  const signed = destination.authority.directory(destination.owner)!;
  return {
    fleetId: signed.document.fleetId,
    grantId: signed.document.members.find(
      (m) => m.machineId === destination.authority.identity.machineId,
    )!.grantId,
    destination: destination.authority.identity.machineId,
    peer: peer.authority.identity.machineId,
    directory: directoryDigest(signed.document),
    operation,
  };
}
function issued(
  destination: Machine,
  peer: Machine,
  operation: FleetOperation = "read",
) {
  const proof = peer.credentials.prove(
    peer.owner,
    destination.credentials.challenge(context(destination, peer, operation)),
  );
  const response = destination.credentials.issue(proof);
  return {
    proof,
    response,
    credential: peer.credentials.accept(peer.owner, proof, response),
  };
}

it("requires a destination grant, proves both machine identities and maps only the destination's local owner", () => {
  const { a, b, c } = fleet(),
    d = machine();
  expect(() => d.credentials.challenge(context(b, a))).toThrow();
  const challenge = b.credentials.challenge(context(b, a));
  expect(
    b.db.prepare("SELECT count(*) n FROM fleet_credential_nonces").get(),
  ).toEqual({ n: 0 });
  expect(() => c.credentials.prove(c.owner, challenge)).toThrow("invalid");
  expect(() => a.credentials.prove("unrelated-owner", challenge)).toThrow(
    "owner",
  );
  const proof = a.credentials.prove(a.owner, challenge);
  const response = b.credentials.issue(proof);
  const credential = a.credentials.accept(a.owner, proof, response);
  expect(b.credentials.authenticate(credential.token)).toMatchObject({
    owner: b.owner,
    context: context(b, a),
    remainingMs: TTL,
  });
  expect(a.owner).not.toBe(b.owner);
  expect(JSON.stringify(response)).not.toContain(b.owner);
  expect(() => c.credentials.authenticate(credential.token)).toThrow("invalid");
});

it("does not consume a nonce for invalid proof and atomically refuses a successful proof replay", () => {
  const { a, b } = fleet();
  const proof = a.credentials.prove(
    a.owner,
    b.credentials.challenge(context(b, a)),
  );
  const invalid = {
    ...proof,
    signature:
      (proof.signature[0] === "A" ? "B" : "A") + proof.signature.slice(1),
  };
  expect(() => b.credentials.issue(invalid)).toThrow("invalid");
  expect(
    b.db.prepare("SELECT count(*) n FROM fleet_credential_nonces").get(),
  ).toEqual({ n: 0 });
  const { credential } = b.credentials.issue(proof);
  expect(() => b.credentials.issue(proof)).toThrow("invalid");
  expect(
    b.db.prepare("SELECT count(*) n FROM fleet_credentials").get(),
  ).toEqual({ n: 1 });
  const stored = JSON.stringify(
    b.db.prepare("SELECT * FROM fleet_credentials").all(),
  );
  expect(stored).not.toContain(credential.token);
  expect(stored).not.toContain(proof.challenge.challenge.nonce);
});

it("rejects altered contexts, foreign destination challenges and response substitution", () => {
  const { a, b, c } = fleet();
  const challenge = b.credentials.challenge(context(b, a));
  const altered = {
    ...challenge,
    challenge: {
      ...challenge.challenge,
      context: { ...challenge.challenge.context, operation: "act" as const },
    },
  };
  expect(() => a.credentials.prove(a.owner, altered)).toThrow("invalid");
  const proof = a.credentials.prove(a.owner, challenge);
  expect(() => c.credentials.issue(proof)).toThrow();
  const first = b.credentials.issue(proof),
    next = issued(b, a);
  expect(() => a.credentials.accept(a.owner, next.proof, first)).toThrow(
    "invalid",
  );
  const substituted = {
    ...first,
    credential: { ...first.credential, remainingMs: 1 },
  };
  expect(() => a.credentials.accept(a.owner, proof, substituted)).toThrow(
    "invalid",
  );
});

it("expires nonce proofs using only the issuing clock, including after restart", () => {
  const { a, b } = fleet();
  const proof = a.credentials.prove(
    a.owner,
    b.credentials.challenge(context(b, a)),
  );
  const original = b.time.wall;
  b.time.wall = original - 1;
  expect(() => b.credentials.issue(proof)).toThrow("expired");
  b.time.wall = original + 60_000;
  b.db.close();
  const restarted = machine(b.time.wall, b.owner, b.path);
  expect(() => restarted.credentials.issue(proof)).toThrow("expired");
});

it("expires within ten minutes with unequal clocks and renews from durable grants after restart", () => {
  const { a, b } = fleet();
  const { credential } = issued(b, a);
  advance(a, 24 * 60 * 60_000);
  advance(b, 9 * 60_000);
  expect(b.credentials.authenticate(credential.token).remainingMs).toBe(60_000);
  b.db.close();
  const restarted = machine(b.time.wall, b.owner, b.path);
  expect(() => restarted.credentials.authenticate(credential.token)).toThrow(
    "expired",
  );
  const fresh = issued(restarted, a).credential;
  advance(restarted, TTL);
  expect(() => restarted.credentials.authenticate(fresh.token)).toThrow(
    "expired",
  );
});

it("persists observed expiry after a refused request so a restart and clock rewind cannot revive it", () => {
  const { a, b, c } = fleet();
  const { credential } = issued(b, a);
  const nonce = a.credentials.prove(
    a.owner,
    c.credentials.challenge(context(c, a)),
  );
  const tokenTime = b.time.wall,
    nonceTime = c.time.wall;
  advance(b, TTL);
  expect(() => b.credentials.authenticate(credential.token)).toThrow("expired");
  advance(c, 60_000);
  expect(() => c.credentials.issue(nonce)).toThrow("expired");
  b.db.close();
  c.db.close();
  const bAgain = machine(tokenTime + 1, b.owner, b.path),
    cAgain = machine(nonceTime + 1, c.owner, c.path);
  expect(() => bAgain.credentials.authenticate(credential.token)).toThrow(
    "expired",
  );
  expect(() => cAgain.credentials.issue(nonce)).toThrow("expired");
});

it("refuses pre-restart credentials even when stalled wall time hid elapsed lifetime", () => {
  const { a, b } = fleet();
  const { credential } = issued(b, a);
  b.time.mono += 9 * 60_000;
  b.db.close();
  const restarted = machine(b.time.wall, b.owner, b.path);
  expect(() => restarted.credentials.authenticate(credential.token)).toThrow(
    "expired",
  );
  expect(
    restarted.credentials.authenticate(issued(restarted, a).credential.token)
      .owner,
  ).toBe(b.owner);
});

it("does not treat the original response as fresh when an old challenge is proved again", () => {
  const { a, b } = fleet();
  const challenge = b.credentials.challenge(context(b, a));
  const first = a.credentials.prove(a.owner, challenge);
  const response = b.credentials.issue(first);
  advance(a, 9 * 60_000);
  advance(b, 9 * 60_000);
  const later = a.credentials.prove(a.owner, challenge);
  expect(() => a.credentials.accept(a.owner, later, response)).toThrow(
    "invalid",
  );
  expect(a.credentials.accept(a.owner, first, response).remainingMs).toBe(
    60_000,
  );
});

it("expires nonce proofs under a stalled wall clock and refuses their prior issuer instance after restart", () => {
  const { a, b, c } = fleet();
  const old = a.credentials.prove(
    a.owner,
    b.credentials.challenge(context(b, a)),
  );
  const stalled = a.credentials.prove(
    a.owner,
    c.credentials.challenge(context(c, a)),
  );
  c.time.mono += 60_000;
  expect(() => c.credentials.issue(stalled)).toThrow("expired");
  b.db.close();
  const restarted = machine(b.time.wall, b.owner, b.path);
  expect(() => restarted.credentials.issue(old)).toThrow("expired");
});

it("subtracts response latency and schedules renewal two minutes early with bounded jitter", () => {
  expect(fleetCredentialTiming(TTL, 9000)).toEqual({
    remainingMs: 591000,
    renewInMs: 471000,
  });
  expect(fleetCredentialTiming(TTL, TTL + 1)).toEqual({
    remainingMs: 0,
    renewInMs: 0,
  });
  expect(fleetCredentialTiming(TTL, 0, 999_999).renewInMs).toBe(
    TTL - 120_000 - 15_000,
  );
  expect(() => fleetCredentialTiming(NaN, 0)).toThrow();
  expect(() => fleetCredentialTiming(TTL, -1)).toThrow();
});

it("does not extend accepted credentials when the issuer clock moves backward or stalls", () => {
  const { a, b, c } = fleet();
  const first = issued(b, a).credential;
  b.time.mono += 0.5;
  expect(b.credentials.authenticate(first.token).remainingMs).toBe(TTL - 1);
  expect(b.credentials.authenticate(first.token).remainingMs).toBe(TTL - 1);
  advance(b, 1000);
  b.credentials.authenticate(first.token);
  b.time.wall -= 1;
  expect(() => b.credentials.authenticate(first.token)).toThrow("expired");
  const second = issued(c, a).credential;
  c.time.mono += TTL;
  expect(() => c.credentials.authenticate(second.token)).toThrow("expired");
  c.db.close();
  const restarted = machine(c.time.wall, c.owner, c.path);
  expect(() => restarted.credentials.authenticate(second.token)).toThrow(
    "expired",
  );
});

it("reauthorizes reads and renewal against the latest directory and known removals", () => {
  const { a, b, c, signed } = fleet();
  const old = issued(b, c).credential;
  const pending = c.credentials.prove(
    c.owner,
    b.credentials.challenge(context(b, c)),
  );
  const removed = a.authority.revise(a.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(signed.document),
    members: signed.document.members.filter(
      (m) => m.machineId !== c.authority.identity.machineId,
    ),
  });
  b.authority.accept(b.owner, removed);
  expect(() => b.credentials.authenticate(old.token)).toThrow("revoked");
  expect(() => b.credentials.issue(pending)).toThrow("revoked");
  expect(() => b.credentials.challenge(context(b, c))).toThrow("revoked");
  c.authority.accept(c.owner, removed);
  expect(() => c.credentials.prove(c.owner, pending.challenge)).toThrow(
    "invalid",
  );
});

it("does not confuse elapsed monotonic time with an observed wall-clock rollback", () => {
  const { a, b } = fleet();
  const { credential } = issued(b, a);
  b.time.mono += 1000;
  expect(b.credentials.authenticate(credential.token).remainingMs).toBe(
    TTL - 1000,
  );
  expect(b.credentials.authenticate(credential.token).remainingMs).toBe(
    TTL - 1000,
  );
});

it("fences an older issuer sharing the database before it can reuse cleared nonce receipts", () => {
  const { a, b } = fleet();
  const first = issued(b, a),
    old = b.credentials;
  b.credentials = new FleetCredentials(b.db, b.authority, secrets, {
    wall: () => b.time.wall,
    monotonic: () => b.time.mono,
  });
  expect(() => old.issue(first.proof)).toThrow("expired");
  expect(() => old.challenge(context(b, a))).toThrow("expired");
  expect(() => old.authenticate(first.credential.token)).toThrow("expired");
  const fresh = issued(b, a);
  expect(b.credentials.authenticate(fresh.credential.token).owner).toBe(
    b.owner,
  );
  expect(() => old.issue(fresh.proof)).toThrow("expired");
});

it.each(["issue", "authenticate", "rejected issue"])(
  "persists monotonic expiry before %s cleanup can discard its deadline",
  (cleanup) => {
    const { a, b } = fleet();
    const expired = issued(b, a).credential,
      expiredBeforeRestart = issued(b, a).credential;
    b.time.mono = TTL - 1;
    const live = issued(b, a);
    const pending = a.credentials.prove(
      a.owner,
      b.credentials.challenge(context(b, a)),
    );
    b.time.mono = TTL;
    if (cleanup === "issue") b.credentials.issue(pending);
    else if (cleanup === "authenticate")
      b.credentials.authenticate(live.credential.token);
    else expect(() => b.credentials.issue(live.proof)).toThrow("invalid");
    // Cleanup must already be durable before either expired token is used.
    expect(
      b.db.prepare("SELECT count(*) n FROM fleet_credentials").get(),
    ).toEqual({ n: cleanup === "issue" ? 2 : 1 });
    expect(() => b.credentials.authenticate(expired.token)).toThrow("expired");
    b.db.close();
    const restarted = machine(b.time.wall, b.owner, b.path);
    expect(() =>
      restarted.credentials.authenticate(expiredBeforeRestart.token),
    ).toThrow("expired");
  },
);

it("rolls back nonce consumption when credential persistence fails", () => {
  const { a, b } = fleet();
  const proof = a.credentials.prove(
    a.owner,
    b.credentials.challenge(context(b, a)),
  );
  b.db.exec(
    "CREATE TRIGGER fixture_fail_credential BEFORE INSERT ON fleet_credentials BEGIN SELECT RAISE(ABORT,'fixture disk failure'); END",
  );
  expect(() => b.credentials.issue(proof)).toThrow("fixture disk failure");
  expect(
    b.db.prepare("SELECT count(*) n FROM fleet_credential_nonces").get(),
  ).toEqual({ n: 0 });
  b.db.exec("DROP TRIGGER fixture_fail_credential");
  expect(
    b.credentials.authenticate(b.credentials.issue(proof).credential.token)
      .owner,
  ).toBe(b.owner);
});

it("renews between peers for longer than ten minutes without a controller or browser", () => {
  const { a, b, c } = fleet();
  a.db.close();
  for (let i = 0; i < 4; i++) {
    const token = issued(c, b, "mail").credential.token;
    advance(b, 8 * 60_000);
    advance(c, 8 * 60_000);
    expect(c.credentials.authenticate(token).remainingMs).toBe(120_000);
  }
});

it("bounds credentials without consuming a valid proof when capacity is full", () => {
  const { a, b } = fleet();
  for (let i = 0; i < 64; i++) issued(b, a);
  const proof = a.credentials.prove(
    a.owner,
    b.credentials.challenge(context(b, a)),
  );
  expect(() => b.credentials.issue(proof)).toThrow("capacity");
  expect(
    b.db.prepare("SELECT count(*) n FROM fleet_credential_nonces").get(),
  ).toEqual({ n: 64 });
  advance(b, TTL);
  expect(b.credentials.authenticate(issued(b, a).credential.token).owner).toBe(
    b.owner,
  );
  expect(
    b.db.prepare("SELECT count(*) n FROM fleet_credentials").get(),
  ).toEqual({ n: 1 });
});

it("does not revive a consumed nonce after expiry cleanup and an issuer clock rollback", () => {
  const { a, b } = fleet();
  const { proof } = issued(b, a);
  const firstTime = b.time.wall;
  advance(b, TTL);
  issued(b, a);
  expect(
    b.db.prepare("SELECT count(*) n FROM fleet_credential_nonces").get(),
  ).toEqual({ n: 1 });
  b.db.close();
  const restarted = machine(firstTime + 1, b.owner, b.path);
  expect(() => restarted.credentials.issue(proof)).toThrow("expired");
  expect(() => restarted.credentials.challenge(context(restarted, a))).toThrow(
    "expired",
  );
});

it("bounds consumed nonce receipts when monotonic time advances but wall time stalls", () => {
  const { a, b } = fleet();
  const original = issued(b, a);
  b.time.mono += TTL;
  issued(b, a);
  expect(
    b.db.prepare("SELECT count(*) n FROM fleet_credential_nonces").get(),
  ).toEqual({ n: 1 });
  expect(() => b.credentials.issue(original.proof)).toThrow("expired");
});

it("accounts for response latency at the production credential acceptance boundary", () => {
  const { a, b } = fleet();
  const proof = a.credentials.prove(
    a.owner,
    b.credentials.challenge(context(b, a)),
  );
  const response = b.credentials.issue(proof);
  advance(a, 15_000);
  const accepted = a.credentials.accept(a.owner, proof, response);
  expect(accepted.remainingMs).toBe(TTL - 15_000);
  expect(accepted.expiresAtMonotonic).toBe(TTL);
  expect(accepted.renewAtMonotonic).toBe(TTL - 120_000);
  expect(() => a.credentials.accept(a.owner, proof, response)).toThrow(
    "invalid",
  );
  const delayed = a.credentials.prove(
    a.owner,
    b.credentials.challenge(context(b, a)),
  );
  const late = b.credentials.issue(delayed);
  advance(a, TTL);
  expect(() => a.credentials.accept(a.owner, delayed, late)).toThrow("expired");
});
