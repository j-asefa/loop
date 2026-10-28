import { afterAll, expect, it } from "vitest";
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations } from "../src/server/migrations.js";
import { FleetAuthority } from "../src/server/fleet-authority.js";
import { FleetDirectorySync } from "../src/server/fleet-directory-sync.js";
import { FleetDirectoryReconcile } from "../src/server/fleet-directory-reconcile.js";
import {
  FleetDistribution,
  type FleetDistributionTransport,
} from "../src/server/fleet-distribution.js";
import {
  directoryDigest,
  generateMachineKey,
} from "../src/server/fleet-crypto.js";
import { FleetProof } from "../src/server/fleet-proof.js";
import type { SignedFleetDirectory } from "../src/shared/fleet.js";
import type { SignedFleetDirectoryPush } from "../src/shared/fleet-directory-sync.js";
import { Problem } from "../src/shared/problem.js";

const root = mkdtempSync(join(tmpdir(), "loop-fleet-distribution-"));
process.env.LOOP_PROFILE = "companion";
process.env.LOOP_DATA_DIR = root;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const secrets = await import("../src/server/secrets.js");
// Build the empty migrated schema once. Every machine still has its own file,
// identity and durable transactions; upgrade cases use their explicit history.
const template = new Database(":memory:");
applyMigrations(template);
const migratedSchema = template.serialize();
template.close();
const databases: Database.Database[] = [];
const workers: FleetDistribution[] = [];
const scope = ["read", "events"] as const;
afterAll(() => {
  for (const worker of workers) worker.close();
  for (const db of databases) if (db.open) db.close();
  rmSync(root, { recursive: true, force: true });
});
function machine(migrations?: string) {
  const dir = join(root, randomUUID()),
    owner = randomUUID();
  mkdirSync(dir);
  const path = join(dir, "workspace.db");
  if (!migrations) writeFileSync(path, migratedSchema);
  const db = new Database(path);
  databases.push(db);
  if (migrations) applyMigrations(db, migrations);
  db.prepare("INSERT INTO deployment_profile VALUES(1,'companion')").run();
  const authority = new FleetAuthority(db, secrets);
  return {
    dir,
    owner,
    db,
    authority,
    proof: new FleetProof(db, authority.identity, secrets),
    sync: new FleetDirectorySync(db, authority, owner, secrets),
    origin: `https://${randomUUID()}.example`,
  };
}
type Machine = ReturnType<typeof machine>;
function revise(
  a: Machine,
  members = a.authority.directory(a.owner)!.document.members,
) {
  return a.authority.revise(a.owner, {
    mutationId: randomUUID(),
    expected: a.authority.status(a.owner).head!,
    members,
  });
}
function enroll(a: Machine, b: Machine) {
  const grantId = randomUUID();
  const signed = revise(a, [
    ...a.authority.directory(a.owner)!.document.members,
    { ...b.authority.identity, grantId, name: "Peer", origin: b.origin },
  ]);
  b.authority.approve(b.owner, {
    mutationId: randomUUID(),
    expected: null,
    kind: "enroll",
    grantId,
    scope: [...scope],
    controller: a.authority.identity,
    directory: signed,
  });
  return signed;
}
function queue(a: Machine, b: Machine, directory: SignedFleetDirectory) {
  a.db
    .prepare(
      "INSERT OR IGNORE INTO fleet_distribution(owner_id,peer_id,directory_digest,state) VALUES(?,?,?,'pending')",
    )
    .run(
      a.owner,
      b.authority.identity.machineId,
      directoryDigest(directory.document),
    );
}
function state(a: Machine, b: Machine, directory: SignedFleetDirectory) {
  return a.db
    .prepare(
      "SELECT state,attempts,next_attempt FROM fleet_distribution WHERE owner_id=? AND peer_id=? AND directory_digest=?",
    )
    .get(
      a.owner,
      b.authority.identity.machineId,
      directoryDigest(directory.document),
    ) as { state: string; attempts: number; next_attempt: number };
}
function fixture(migrations?: string) {
  const a = machine(migrations),
    b = machine(migrations);
  a.authority.create(a.owner, {
    mutationId: randomUUID(),
    name: "Controller",
    origin: a.origin,
    scope: [...scope],
  });
  const first = enroll(a, b);
  const targets = new Map([
    [a.origin, a],
    [b.origin, b],
  ]);
  const sent: SignedFleetDirectoryPush[] = [];
  const transport: FleetDistributionTransport = {
    async probe(origin, probe) {
      const peer = targets.get(origin)!;
      return { probe, signature: peer.proof.sign("enrollment-probe", probe) };
    },
    async history(origin, request) {
      return targets.get(origin)!.sync.history(request);
    },
    async push(origin, request) {
      sent.push(request);
      return targets.get(origin)!.sync.receive(request);
    },
  };
  let now = 100,
    observed = 0;
  function worker(source = a, network = transport, db = source.db) {
    const authority =
      db === source.db ? source.authority : new FleetAuthority(db, secrets);
    const worker = new FleetDistribution(
      db,
      authority,
      source.owner,
      secrets,
      network,
      () => {
        expect(db.inTransaction).toBe(false);
        observed++;
      },
      { monotonic: () => now, random: () => 0.5 },
    );
    workers.push(worker);
    return worker;
  }
  return {
    a,
    b,
    first,
    targets,
    sent,
    transport,
    worker,
    time: (value: number) => {
      now = value;
    },
    observed: () => observed,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

it("upgrades populated pre-distribution databases without changing owner grants or pending work", async () => {
  const baseline = join(root, "before-distribution"),
    source = fileURLToPath(new URL("../migrations/", import.meta.url));
  mkdirSync(baseline);
  for (const name of readdirSync(source)) {
    if (name.endsWith(".sql") && Number(name.split("-")[0]) <= 133)
      copyFileSync(join(source, name), join(baseline, name));
  }
  const f = fixture(baseline),
    target = revise(f.a);
  queue(f.a, f.b, target);
  const initial = [f.a, f.b].map((machine) => ({
    state: machine.authority.status(machine.owner),
    grants: machine.db
      .prepare("SELECT * FROM fleet_peer_grants ORDER BY peer_id")
      .all(),
  }));
  for (const [i, machine] of [f.a, f.b].entries()) {
    applyMigrations(machine.db);
    expect(machine.authority.status(machine.owner)).toEqual(initial[i].state);
    expect(
      machine.db
        .prepare("SELECT * FROM fleet_peer_grants ORDER BY peer_id")
        .all(),
    ).toEqual(initial[i].grants);
    expect(machine.db.pragma("foreign_key_check")).toEqual([]);
  }
  expect(state(f.a, f.b, target).state).toBe("pending");
  await f.worker().flush();
  expect(state(f.a, f.b, target).state).toBe("acked");
  expect(f.b.authority.status(f.b.owner).head).toBe(
    directoryDigest(target.document),
  );
  applyMigrations(f.a.db);
  expect(state(f.a, f.b, target).state).toBe("acked");
});

it("distributes a committed revision and acknowledges only its owner-bound outbox after acceptance", async () => {
  const f = fixture(),
    target = revise(f.a);
  queue(f.a, f.b, target);
  const otherOwner = randomUUID();
  f.a.db
    .prepare(
      "INSERT INTO fleet_distribution(owner_id,peer_id,directory_digest,state) VALUES(?,?,?,'pending')",
    )
    .run(
      otherOwner,
      f.b.authority.identity.machineId,
      directoryDigest(target.document),
    );
  await f.worker().flush();
  expect(f.sent).toHaveLength(1);
  expect(f.b.authority.status(f.b.owner).head).toBe(
    directoryDigest(target.document),
  );
  expect(state(f.a, f.b, target).state).toBe("acked");
  expect(
    f.a.db
      .prepare("SELECT state FROM fleet_distribution WHERE owner_id=?")
      .get(otherOwner),
  ).toEqual({ state: "pending" });
  expect(
    f.a.db.prepare("SELECT count(*) n FROM fleet_distribution_work").get(),
  ).toEqual({ n: 0 });
  expect(f.observed()).toBe(1);
});

it("retries the exact durable push after a lost acknowledgement and a replacement database connection", async () => {
  const f = fixture(),
    target = revise(f.a);
  queue(f.a, f.b, target);
  let encoded = "";
  const old = f.worker(f.a, {
    ...f.transport,
    async push(origin, request) {
      encoded = JSON.stringify(request);
      expect(
        f.a.db.prepare("SELECT request FROM fleet_distribution_work").get(),
      ).toEqual({ request: encoded });
      await f.transport.push(origin, request);
      throw new Error("reply lost");
    },
  });
  await old.flush();
  expect(state(f.a, f.b, target)).toEqual({
    state: "pending",
    attempts: 1,
    next_attempt: 1100,
  });
  const reopened = new Database(join(f.a.dir, "workspace.db"));
  databases.push(reopened);
  const replacement = f.worker(
    f.a,
    {
      probe: f.transport.probe,
      async history() {
        throw new Error("must reconcile the stored push first");
      },
      async push(origin, request) {
        expect(JSON.stringify(request)).toBe(encoded);
        return f.transport.push(origin, request);
      },
    },
    reopened,
  );
  await replacement.flush();
  expect(state(f.a, f.b, target).state).toBe("acked");
  expect(f.sent).toHaveLength(2);
  expect(
    f.b.db
      .prepare(
        "SELECT count(*) n FROM fleet_directory_history WHERE owner_id=? AND digest=?",
      )
      .get(f.b.owner, directoryDigest(target.document)),
  ).toEqual({ n: 1 });
  expect(() => old.flush()).toThrow("replaced");
});

it("sends long histories in bounded batches and retires earlier pending revisions on the same lineage", async () => {
  const f = fixture(),
    revisions: SignedFleetDirectory[] = [];
  // Only setup is batched. Each production flush below keeps its real commit.
  f.a.db.transaction(() => {
    for (let i = 0; i < 70; i++) {
      const next = revise(f.a);
      revisions.push(next);
      queue(f.a, f.b, next);
    }
  })();
  const worker = f.worker();
  await worker.flush();
  expect(f.sent[0].push.entries).toHaveLength(32);
  expect(state(f.a, f.b, revisions.at(-1)!).state).toBe("pending");
  await worker.flush();
  await worker.flush();
  expect(f.sent.map((x) => x.push.entries.length)).toEqual([32, 32, 6]);
  expect(
    f.a.db
      .prepare(
        "SELECT count(*) n FROM fleet_distribution WHERE owner_id=? AND state='pending'",
      )
      .get(f.a.owner),
  ).toEqual({ n: 0 });
  expect(f.b.authority.status(f.b.owner).head).toBe(
    directoryDigest(revisions.at(-1)!.document),
  );
});

it("keeps an offline peer pending with bounded backoff and shares a single flush", async () => {
  const f = fixture(),
    target = revise(f.a),
    gate = deferred<unknown>();
  queue(f.a, f.b, target);
  let calls = 0;
  const worker = f.worker(f.a, {
    ...f.transport,
    async history() {
      calls++;
      await gate.promise;
      throw new Error("offline");
    },
  });
  const pending = worker.flush();
  expect(worker.flush()).toBe(pending);
  gate.resolve(null);
  await pending;
  expect(calls).toBe(1);
  expect(state(f.a, f.b, target).state).toBe("pending");
  await worker.flush();
  expect(calls).toBe(1);
  f.time(1100);
  await worker.flush();
  expect(calls).toBe(2);
  expect(state(f.a, f.b, target).next_attempt).toBe(3100);
  expect(f.sent).toHaveLength(0);
});

it("bounds both delivery slots and advances other peers before repeating a long pending history", async () => {
  const f = fixture(),
    c = machine(),
    d = machine();
  f.targets.set(c.origin, c);
  f.targets.set(d.origin, d);
  enroll(f.a, c);
  enroll(f.a, d);
  f.a.db.transaction(() => {
    for (let i = 0; i < 70; i++) revise(f.a);
  })();
  const target = f.a.authority.directory(f.a.owner)!;
  for (const peer of [f.b, c, d]) queue(f.a, peer, target);
  let active = 0,
    maximum = 0;
  const worker = f.worker(f.a, {
    ...f.transport,
    async history(origin, request) {
      active++;
      maximum = Math.max(maximum, active);
      try {
        await Promise.resolve();
        return await f.transport.history(origin, request);
      } finally {
        active--;
      }
    },
  });
  await worker.flush();
  expect(maximum).toBe(2);
  expect(
    new Set(f.sent.map((packet) => packet.push.destination.machineId)).size,
  ).toBe(2);
  await worker.flush();
  expect(
    new Set(f.sent.map((packet) => packet.push.destination.machineId)).size,
  ).toBe(3);
  expect(f.sent.every((packet) => packet.push.entries.length === 32)).toBe(
    true,
  );
}, 20_000);

it("refuses an acknowledgement from another signed request without marking synchronization", async () => {
  const f = fixture(),
    target = revise(f.a);
  queue(f.a, f.b, target);
  const worker = f.worker(f.a, {
    ...f.transport,
    async push(origin, request) {
      const accepted = (await f.transport.push(origin, request)) as {
        ack: { requestDigest: string };
        signature: string;
      };
      return {
        ...accepted,
        ack: { ...accepted.ack, requestDigest: "f".repeat(64) },
      };
    },
  });
  await worker.flush();
  expect(f.b.authority.status(f.b.owner).head).toBe(
    directoryDigest(target.document),
  );
  expect(state(f.a, f.b, target).state).toBe("pending");
  expect(
    f.a.db.prepare("SELECT count(*) n FROM fleet_distribution_work").get(),
  ).toEqual({ n: 1 });
});

it("delivers a removal directly to the last known endpoint and retains its accepted acknowledgement after reply loss", async () => {
  const f = fixture();
  const removed = revise(
    f.a,
    f.first.document.members.filter(
      (m) => m.machineId !== f.b.authority.identity.machineId,
    ),
  );
  queue(f.a, f.b, removed);
  let lost = true;
  const worker = f.worker(f.a, {
    ...f.transport,
    async push(origin, request) {
      expect(origin).toBe(f.b.origin);
      const response = await f.transport.push(origin, request);
      if (lost) {
        lost = false;
        throw new Error("lost removal ack");
      }
      return response;
    },
  });
  await worker.flush();
  expect(f.b.authority.status(f.b.owner).state).toBe("removed");
  expect(state(f.a, f.b, removed).state).toBe("pending");
  f.time(1100);
  await worker.flush();
  expect(state(f.a, f.b, removed).state).toBe("acked");
  expect(f.sent[1]).toEqual(f.sent[0]);
  expect(
    f.b.db
      .prepare("SELECT count(*) n FROM fleet_peer_grants WHERE active=1")
      .get(),
  ).toEqual({ n: 0 });
});

it("acknowledges an already learned removal when retained history exceeds the admission budget", async () => {
  const f = fixture(),
    members = [...f.first.document.members];
  for (let i = members.length; i < 128; i++)
    members.push({
      ...generateMachineKey().identity,
      grantId: randomUUID(),
      name: "Large roster",
      origin: `https://peer-${i}.${("a".repeat(50) + ".").repeat(36)}example`,
    });
  let retainedBytes = 0;
  for (let i = 0; i < 5; i++) {
    const entry = revise(f.a, members);
    retainedBytes += Buffer.byteLength(JSON.stringify(entry));
    f.b.authority.accept(f.b.owner, entry);
  }
  expect(retainedBytes).toBeGreaterThan(768 * 1024);
  const removed = revise(
    f.a,
    members.filter((m) => m.machineId !== f.b.authority.identity.machineId),
  );
  f.b.authority.accept(f.b.owner, removed);
  queue(f.a, f.b, removed);
  await f.worker().flush();
  expect(state(f.a, f.b, removed).state).toBe("acked");
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0].push.entries).toEqual([removed]);
  expect(f.b.authority.status(f.b.owner).state).toBe("removed");
});

it("does not disclose historical rosters after an unsigned refusal at a reassigned origin", async () => {
  const f = fixture(),
    outsider = machine(),
    target = revise(f.a);
  queue(f.a, f.b, target);
  let disclosures = 0;
  const worker = f.worker(f.a, {
    ...f.transport,
    async history(_origin, request) {
      if (request.query.admission) disclosures++;
      throw new Problem(403, "Unsigned fixture refusal");
    },
    async probe(_origin, probe) {
      return {
        probe,
        signature: outsider.proof.sign("enrollment-probe", probe),
      };
    },
  });
  await worker.flush();
  expect(disclosures).toBe(0);
  expect(f.sent).toHaveLength(0);
  expect(state(f.a, f.b, target).state).toBe("pending");
});

it("rechecks destination identity before retransmitting a persisted directory packet", async () => {
  const f = fixture(),
    outsider = machine(),
    target = revise(f.a);
  queue(f.a, f.b, target);
  const first = f.worker(f.a, {
    ...f.transport,
    async push(origin, request) {
      await f.transport.push(origin, request);
      throw new Error("Lost fixture acknowledgement");
    },
  });
  await first.flush();
  expect(f.sent).toHaveLength(1);
  const replacement = f.worker(f.a, {
    ...f.transport,
    async probe(_origin, probe) {
      return {
        probe,
        signature: outsider.proof.sign("enrollment-probe", probe),
      };
    },
  });
  await replacement.flush();
  expect(f.sent).toHaveLength(1);
  expect(state(f.a, f.b, target).state).toBe("pending");
});

it("fences a late response after replacement while the new worker reconciles the same stored push", async () => {
  const f = fixture(),
    target = revise(f.a),
    gate = deferred<unknown>();
  queue(f.a, f.b, target);
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const old = f.worker(f.a, {
    ...f.transport,
    async push(origin, request) {
      const response = await f.transport.push(origin, request);
      began();
      await gate.promise;
      return response;
    },
  });
  const pending = old.flush();
  await started;
  const newer = f.worker();
  gate.resolve(null);
  await pending;
  expect(state(f.a, f.b, target)).toEqual({
    state: "pending",
    attempts: 0,
    next_attempt: 0,
  });
  await newer.flush();
  expect(state(f.a, f.b, target).state).toBe("acked");
  expect(f.sent[1]).toEqual(f.sent[0]);
});

it("fences the outbox after explicit recovery instead of replaying work from the prior authority", async () => {
  const f = fixture(),
    target = revise(f.a);
  queue(f.a, f.b, target);
  await f
    .worker(f.a, {
      ...f.transport,
      async push() {
        throw new Error("uncertain send");
      },
    })
    .flush();
  const recovery = f.a.authority.recover(f.a.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(target.document),
    name: "Reset",
    origin: f.a.origin,
    scope: [...scope],
  });
  const worker = f.worker();
  await worker.flush();
  expect(state(f.a, f.b, target).state).toBe("incompatible");
  expect(f.sent).toHaveLength(0);
  expect(f.a.authority.status(f.a.owner).head).toBe(
    directoryDigest(recovery.document),
  );
});

it("aborts an uncooperative transport on close and refuses later acknowledgement callbacks", async () => {
  const f = fixture(),
    target = revise(f.a),
    gate = deferred<unknown>();
  queue(f.a, f.b, target);
  let began!: () => void, signal: AbortSignal | undefined;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const worker = f.worker(f.a, {
    ...f.transport,
    async push(origin, request, stopped) {
      signal = stopped;
      const response = await f.transport.push(origin, request);
      began();
      await gate.promise;
      return response;
    },
  });
  const pending = worker.flush();
  await started;
  worker.close();
  await pending;
  expect(signal?.aborted).toBe(true);
  expect(state(f.a, f.b, target).state).toBe("pending");
  gate.resolve(null);
  await Promise.resolve();
  expect(state(f.a, f.b, target).state).toBe("pending");
});

it.each(["history", "probe", "reconcile"] as const)(
  "closes during %s without accepting late callbacks",
  async (phase) => {
    const f = fixture(),
      target = revise(f.a),
      gate = deferred<void>(),
      entered = deferred<void>();
    const source = phase === "reconcile" ? f.b : f.a,
      destination = phase === "reconcile" ? f.a : f.b;
    const queued = phase === "reconcile" ? f.first : target;
    queue(source, destination, queued);
    let reads = 0;
    const worker = f.worker(source, {
      ...f.transport,
      async history(origin, input, signal) {
        const response = await f.transport.history(origin, input, signal);
        if (
          ++reads === (phase === "history" ? 1 : phase === "reconcile" ? 2 : -1)
        ) {
          entered.resolve();
          await gate.promise;
        }
        return response;
      },
      async probe(origin, input, signal) {
        const response = await f.transport.probe(origin, input, signal);
        if (phase === "probe") {
          entered.resolve();
          await gate.promise;
        }
        return response;
      },
    });
    const operation = worker.flush();
    await entered.promise;
    worker.close();
    await operation;
    gate.resolve();
    await Promise.resolve();
    expect(state(source, destination, queued)).toMatchObject({
      state: "pending",
      attempts: 0,
    });
    expect(f.sent).toHaveLength(0);
    expect(f.b.authority.status(f.b.owner).head).toBe(
      directoryDigest(f.first.document),
    );
  },
);

it("introduces a successor controller to a replica that went offline before its admission", async () => {
  const f = fixture(),
    c = machine();
  const admitted = enroll(f.a, c);
  const proposal = f.a.authority.prepareHandoff(f.a.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(admitted.document),
    destination: c.authority.identity,
  });
  const handoff = c.authority.acceptHandoff(c.owner, proposal);
  queue(c, f.b, handoff);
  f.targets.delete(f.a.origin);
  await f.worker(c).flush();
  expect(f.b.authority.status(f.b.owner).head).toBe(
    directoryDigest(handoff.document),
  );
  expect(state(c, f.b, handoff).state).toBe("acked");
});

it("delivers a successor controller's admission beyond the first update page", async () => {
  const f = fixture(),
    c = machine(),
    revisions = [f.first];
  f.a.db.transaction(() => {
    for (let i = 0; i < 40; i++) revisions.push(revise(f.a));
  })();
  const admitted = enroll(f.a, c);
  const ancestors = [...revisions].reverse();
  for (let i = 0; i < ancestors.length; i += 32)
    c.authority.retainAncestors(c.owner, ancestors.slice(i, i + 32));
  const proposal = f.a.authority.prepareHandoff(f.a.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(admitted.document),
    destination: c.authority.identity,
  });
  const handoff = c.authority.acceptHandoff(c.owner, proposal);
  queue(c, f.b, handoff);
  f.targets.delete(f.a.origin);
  const worker = f.worker(c);
  await worker.flush();
  expect(f.b.authority.status(f.b.owner).head).toBe(
    directoryDigest(revisions[32].document),
  );
  expect(
    f.b.db
      .prepare(
        "SELECT count(*) n FROM fleet_peer_grants WHERE peer_id=? AND active=1",
      )
      .get(c.authority.identity.machineId),
  ).toEqual({ n: 0 });
  expect(state(c, f.b, handoff).state).toBe("pending");
  await worker.flush();
  expect(f.b.authority.status(f.b.owner).head).toBe(
    directoryDigest(handoff.document),
  );
  expect(state(c, f.b, handoff).state).toBe("acked");
  expect(f.sent).toHaveLength(2);
});

it("fences reconciliation before a replaced worker can install returned authority", async () => {
  const f = fixture(),
    target = revise(f.a),
    gate = deferred<unknown>(),
    entered = deferred<void>();
  queue(f.b, f.a, f.first);
  let calls = 0;
  const old = f.worker(f.b, {
    ...f.transport,
    async history(origin, input) {
      const response = await f.transport.history(origin, input);
      if (++calls === 2) {
        entered.resolve();
        await gate.promise;
      }
      return response;
    },
  });
  const operation = old.flush();
  await entered.promise;
  const replacement = f.worker(f.b);
  gate.resolve(null);
  await operation;
  expect(f.b.authority.status(f.b.owner).head).toBe(
    directoryDigest(f.first.document),
  );
  expect(state(f.b, f.a, f.first)).toEqual({
    state: "pending",
    attempts: 0,
    next_attempt: 0,
  });
  await replacement.flush();
  expect(f.b.authority.status(f.b.owner).head).toBe(
    directoryDigest(target.document),
  );
});

it("retries a synchronization race after another caller installs the same valid directory", async () => {
  const f = fixture(),
    target = revise(f.a),
    gate = deferred<unknown>(),
    entered = deferred<void>();
  queue(f.b, f.a, f.first);
  let calls = 0;
  const worker = f.worker(f.b, {
    ...f.transport,
    async history(origin, input) {
      const response = await f.transport.history(origin, input);
      if (++calls === 2) {
        entered.resolve();
        await gate.promise;
      }
      return response;
    },
  });
  const operation = worker.flush();
  await entered.promise;
  f.b.authority.accept(f.b.owner, target);
  gate.resolve(null);
  await operation;
  expect(state(f.b, f.a, f.first).state).toBe("pending");
  f.time(1100);
  await worker.flush();
  expect(state(f.b, f.a, f.first).state).toBe("acked");
});

it("keeps a temporary peer conflict retryable instead of permanently retiring its delivery", async () => {
  const f = fixture(),
    target = revise(f.a);
  queue(f.a, f.b, target);
  let busy = true;
  const worker = f.worker(f.a, {
    ...f.transport,
    async push(origin, input) {
      if (busy) {
        busy = false;
        throw new Problem(409, "Resolve the pending local operation first.");
      }
      return f.transport.push(origin, input);
    },
  });
  await worker.flush();
  expect(state(f.a, f.b, target).state).toBe("pending");
  f.time(1100);
  await worker.flush();
  expect(state(f.a, f.b, target).state).toBe("acked");
});

it("leaves an injected reconciler available after its distribution worker closes", async () => {
  const f = fixture(),
    target = revise(f.a);
  const reconcile = new FleetDirectoryReconcile(
    f.b.db,
    f.b.authority,
    f.b.owner,
    secrets,
    f.transport,
  );
  const worker = new FleetDistribution(
    f.b.db,
    f.b.authority,
    f.b.owner,
    secrets,
    f.transport,
    undefined,
    { reconcile },
  );
  workers.push(worker);
  worker.close();
  try {
    expect(await reconcile.from(f.a.authority.identity.machineId)).toBe(true);
    expect(f.b.authority.status(f.b.owner).head).toBe(
      directoryDigest(target.document),
    );
  } finally {
    reconcile.close();
  }
});

it("closes on monotonic rollback before consuming a returned acknowledgement", async () => {
  const f = fixture(),
    target = revise(f.a);
  queue(f.a, f.b, target);
  const worker = f.worker(f.a, {
    ...f.transport,
    async push(origin, request) {
      const response = await f.transport.push(origin, request);
      f.time(99);
      return response;
    },
  });
  await worker.flush();
  expect(state(f.a, f.b, target).state).toBe("pending");
  expect(() => worker.flush()).toThrow();
});
