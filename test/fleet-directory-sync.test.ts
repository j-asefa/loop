import { afterAll, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations } from "../src/server/migrations.js";
import { FleetAuthority } from "../src/server/fleet-authority.js";
import {
  FleetDirectorySync,
  verifyFleetDirectoryAck,
  verifyFleetHistoryResponse,
} from "../src/server/fleet-directory-sync.js";
import { FleetProof, verifyFleetProof } from "../src/server/fleet-proof.js";
import {
  directoryDigest,
  fleetPayloadDigest,
  generateMachineKey,
  signDirectory,
} from "../src/server/fleet-crypto.js";
import type { SignedFleetDirectory } from "../src/shared/fleet.js";
import type { SignedFleetDirectoryPush } from "../src/shared/fleet-directory-sync.js";
import { secret } from "../src/state.js";

const root = mkdtempSync(join(tmpdir(), "loop-fleet-directory-"));
process.env.LOOP_PROFILE = "companion";
process.env.LOOP_DATA_DIR = root;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const secrets = await import("../src/server/secrets.js");
const databases: Database.Database[] = [];
const scope = ["read", "events"] as const;
afterAll(() => {
  for (const db of databases) if (db.open) db.close();
  rmSync(root, { recursive: true, force: true });
});
function machine() {
  const dir = join(root, randomUUID()),
    owner = randomUUID();
  mkdirSync(dir);
  const db = new Database(join(dir, "workspace.db"));
  databases.push(db);
  applyMigrations(db);
  db.prepare("INSERT INTO deployment_profile VALUES(1,'companion')").run();
  const authority = new FleetAuthority(db, secrets);
  const proof = new FleetProof(db, authority.identity, secrets);
  const sync = new FleetDirectorySync(db, authority, owner, secrets);
  return {
    dir,
    owner,
    db,
    authority,
    proof,
    sync,
    origin: `https://${randomUUID()}.example`,
  };
}
type Machine = ReturnType<typeof machine>;
function revise(
  a: Machine,
  members: SignedFleetDirectory["document"]["members"],
) {
  return a.authority.revise(a.owner, {
    mutationId: randomUUID(),
    expected: a.authority.status(a.owner).head!,
    members,
  });
}
function enroll(a: Machine, b: Machine) {
  const current = a.authority.directory(a.owner)!;
  const grantId = randomUUID();
  const signed = revise(a, [
    ...current.document.members,
    { ...b.authority.identity, grantId, name: "Same name", origin: b.origin },
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
function fixture() {
  const a = machine(),
    b = machine(),
    c = machine();
  a.authority.create(a.owner, {
    mutationId: randomUUID(),
    name: "Same name",
    origin: a.origin,
    scope: [...scope],
  });
  const first = enroll(a, b),
    second = enroll(a, c);
  return { a, b, c, first, second };
}
function push(
  sender: Machine,
  destination: Machine,
  anchor: SignedFleetDirectory,
  entries: SignedFleetDirectory[],
  admission?: SignedFleetDirectory[],
): SignedFleetDirectoryPush {
  const push = {
    version: 1 as const,
    nonce: secret(),
    sender: sender.authority.identity,
    destination: destination.authority.identity,
    anchor: directoryDigest(anchor.document),
    entries,
    ...(admission ? { admission } : {}),
  };
  return { push, signature: sender.proof.sign("directory-sync", push) };
}
function history(
  sender: Machine,
  destination: Machine,
  cursor: string | null = null,
  admission?: SignedFleetDirectory[],
) {
  const query = {
    version: 1 as const,
    nonce: secret(),
    sender: sender.authority.identity,
    destination: destination.authority.identity,
    cursor,
    ...(admission ? { admission } : {}),
  };
  return { query, signature: sender.proof.sign("directory-query", query) };
}

it("permits history discovery through an anchored admission proof without activating the new peer's grant", () => {
  const { a, b, c, first, second } = fixture(),
    outsider = machine();
  const before = b.db
    .prepare("SELECT * FROM fleet_peer_grants ORDER BY peer_id")
    .all();
  expect(() => b.sync.history(history(c, b))).toThrow("outside");
  const query = history(c, b, null, [second]);
  const response = b.sync.history(query);
  expect(verifyFleetHistoryResponse(query, response).page.head).toBe(
    directoryDigest(first.document),
  );
  expect(b.authority.status(b.owner).head).toBe(
    directoryDigest(first.document),
  );
  expect(
    b.db.prepare("SELECT * FROM fleet_peer_grants ORDER BY peer_id").all(),
  ).toEqual(before);
  expect(() => b.sync.history(history(outsider, b, null, [second]))).toThrow(
    "outside",
  );
  expect(() =>
    b.sync.history(
      history(c, b, null, [{ ...second, signature: first.signature }]),
    ),
  ).toThrow();
  const foreign = new FleetDirectorySync(b.db, b.authority, a.owner, secrets);
  expect(() => foreign.history(query)).toThrow();
  b.authority.recover(b.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(first.document),
    name: "Reset",
    origin: b.origin,
    scope: [...scope],
  });
  expect(() => b.sync.history(query)).toThrow("outside");
});

it("authenticates a paged update by its admission continuation without installing that continuation", () => {
  const a = machine(),
    b = machine(),
    c = machine();
  a.authority.create(a.owner, {
    mutationId: randomUUID(),
    name: "A",
    origin: a.origin,
    scope: [...scope],
  });
  const first = enroll(a, b),
    prefix = revise(a, first.document.members);
  const admitted = enroll(a, c);
  const outsider = machine();
  const invalid = push(
    c,
    b,
    first,
    [prefix],
    [{ ...admitted, signature: first.signature }],
  );
  expect(() => b.sync.receive(invalid)).toThrow();
  expect(() =>
    b.sync.receive(push(outsider, b, first, [prefix], [admitted])),
  ).toThrow("outside");
  const request = push(c, b, first, [prefix], [admitted]);
  const response = b.sync.receive(request);
  expect(verifyFleetDirectoryAck(request, first, response).ack.accepted).toBe(
    directoryDigest(prefix.document),
  );
  expect(b.authority.status(b.owner).head).toBe(
    directoryDigest(prefix.document),
  );
  expect(
    b.authority.directory(b.owner, directoryDigest(admitted.document)),
  ).toBeUndefined();
  expect(
    b.db
      .prepare(
        "SELECT count(*) n FROM fleet_peer_grants WHERE peer_id=? AND active=1",
      )
      .get(c.authority.identity.machineId),
  ).toEqual({ n: 0 });
  expect(b.sync.receive(request)).toEqual(response);
  b.authority.recover(b.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(prefix.document),
    name: "Reset",
    origin: b.origin,
    scope: [...scope],
  });
  expect(() => b.sync.receive(request)).toThrow();
});

it("retains verified predecessors atomically without moving authority or restoring grants", () => {
  const { a, c, first, second } = fixture();
  const genesis = a.authority.directory(a.owner, first.document.parent!)!;
  const original = c.authority.status(c.owner);
  const grants = c.db
    .prepare("SELECT * FROM fleet_peer_grants ORDER BY peer_id")
    .all();
  expect(
    c.authority.directory(c.owner, directoryDigest(first.document)),
  ).toBeUndefined();
  expect(() =>
    c.authority.retainAncestors(c.owner, [
      first,
      { ...genesis, signature: first.signature },
    ]),
  ).toThrow();
  expect(
    c.authority.directory(c.owner, directoryDigest(first.document)),
  ).toBeUndefined();
  expect(c.authority.retainAncestors(c.owner, [first, genesis])).toBe(true);
  expect(c.authority.status(c.owner)).toEqual(original);
  expect(
    c.db.prepare("SELECT * FROM fleet_peer_grants ORDER BY peer_id").all(),
  ).toEqual(grants);
  expect(() => c.authority.retainAncestors(a.owner, [first])).toThrow();
  c.authority.recover(c.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(second.document),
    name: "Reset",
    origin: c.origin,
    scope: [...scope],
  });
  expect(c.authority.retainAncestors(c.owner, [first])).toBe(false);
});

it("accepts a new peer's signed admission relay and derives grants only within the local owner's consent", () => {
  const { a, b, c, first, second } = fixture();
  const request = push(c, b, first, [second]);
  const response = b.sync.receive(request);
  expect(verifyFleetDirectoryAck(request, first, response)).toEqual(response);
  const replay = push(c, b, first, [second]);
  expect(() => verifyFleetDirectoryAck(replay, first, response)).toThrow(
    "outside",
  );
  expect(response.ack.requestDigest).toBe(fleetPayloadDigest(request.push));
  expect(response.ack.accepted).toBe(directoryDigest(second.document));
  expect(
    verifyFleetProof(
      b.authority.identity,
      "directory-ack",
      response.ack,
      response.signature,
    ),
  ).toBe(true);
  const local = second.document.members.find(
    (m) => m.machineId === b.authority.identity.machineId,
  )!;
  const context = {
    fleetId: second.document.fleetId,
    grantId: local.grantId,
    destination: b.authority.identity.machineId,
    peer: c.authority.identity.machineId,
    directory: directoryDigest(second.document),
    operation: "read" as const,
  };
  expect(b.authority.authorize(context).owner).toBe(b.owner);
  expect(b.owner).not.toBe(a.owner);
  expect(() => b.authority.authorize({ ...context, operation: "act" })).toThrow(
    "outside",
  );
  expect(b.sync.receive(request).ack).toEqual(response.ack);
  const otherOwner = new FleetDirectorySync(
    b.db,
    b.authority,
    a.owner,
    secrets,
  );
  expect(() => otherOwner.receive(request)).toThrow("no fleet grant");
});

it("rejects an unenrolled directory sender before waiting for a concurrent database writer", () => {
  const { b, first, second } = fixture(),
    outsider = machine();
  const request = push(outsider, b, first, [second]);
  const writer = new Database(b.db.name);
  b.db.pragma("busy_timeout=25");
  writer.exec("BEGIN IMMEDIATE");
  try {
    expect(() => b.sync.receive(request)).toThrow("outside");
  } finally {
    writer.exec("ROLLBACK");
    writer.close();
    b.db.pragma("busy_timeout=5000");
  }
  expect(b.authority.status(b.owner).head).toBe(
    directoryDigest(first.document),
  );
});

it("serves nonce-bound signed history from a replica without controller contact or bearer credentials", () => {
  const { b, c, first, second } = fixture();
  b.sync.receive(push(c, b, first, [second]));
  const request = history(c, b);
  const response = b.sync.history(request);
  expect(verifyFleetHistoryResponse(request, response)).toEqual(response);
  expect(() => verifyFleetHistoryResponse(history(c, b), response)).toThrow(
    "outside",
  );
  expect(response.page.queryDigest).toBe(fleetPayloadDigest(request.query));
  expect(response.page.entries).toEqual([second, first]);
  expect(response.page.next).toBe(first.document.parent);
  expect(
    verifyFleetProof(
      b.authority.identity,
      "directory-history",
      response.page,
      response.signature,
    ),
  ).toBe(true);
  expect(JSON.stringify(response)).not.toContain(b.owner);
  const changed = { ...request, query: { ...request.query, nonce: secret() } };
  expect(() => b.sync.history(changed)).toThrow("outside");
  const outsider = machine();
  expect(() => b.sync.history(history(outsider, b))).toThrow("outside");
});

it("bounds history pages and preserves a cursor without treating a missing ancestor as a root", () => {
  const { a, b } = fixture();
  for (let i = 0; i < 35; i++)
    revise(a, a.authority.directory(a.owner)!.document.members);
  const page = a.sync.history(history(b, a));
  expect(page.page.entries).toHaveLength(32);
  expect(page.page.next).not.toBeNull();
  const next = a.sync.history(history(b, a, page.page.next));
  expect(directoryDigest(next.page.entries[0].document)).toBe(page.page.next);
  expect(next.page.entries.at(-1)!.document.kind).toBe("genesis");
  expect(next.page.next).toBeNull();
  expect(() => a.sync.history(history(b, a, "f".repeat(64)))).toThrow(
    "outside",
  );
});

it("rejects arbitrary cursor probes without walking long history and still serves old retained cursors", async () => {
  const { a, b, first } = fixture();
  for (let i = 0; i < 1025; i++) {
    revise(a, a.authority.directory(a.owner)!.document.members);
    if (i % 64 === 0)
      await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await Promise.resolve(); // committed history indexing is independent of peer input
  const reads = vi.spyOn(a.authority as any, "saved");
  try {
    for (let i = 0; i < 8; i++)
      expect(() =>
        a.sync.history(history(b, a, randomBytes(32).toString("hex"))),
      ).toThrow("outside");
    // Only current authority is read. Random cursor values never enter the
    // verified ancestry cache or trigger one signature check per old revision.
    expect(reads.mock.calls.length).toBeLessThanOrEqual(8);
    reads.mockClear();
    const request = history(b, a, directoryDigest(first.document));
    expect(
      verifyFleetHistoryResponse(
        request,
        a.sync.history(request),
      ).page.entries.at(-1)!.document.kind,
    ).toBe("genesis");
    expect(reads.mock.calls.length).toBeLessThanOrEqual(33);
    const removed = revise(
      a,
      a.authority
        .directory(a.owner)!
        .document.members.filter(
          (member) => member.machineId !== b.authority.identity.machineId,
        ),
    );
    const after = revise(a, removed.document.members);
    await Promise.resolve();
    reads.mockClear();
    expect(() =>
      a.sync.history(history(b, a, directoryDigest(after.document))),
    ).toThrow("outside");
    const earlier = history(b, a, directoryDigest(first.document));
    expect(
      verifyFleetHistoryResponse(earlier, a.sync.history(earlier)).page.head,
    ).toBe(directoryDigest(removed.document));
    expect(reads.mock.calls.length).toBeLessThanOrEqual(40);
  } finally {
    reads.mockRestore();
  }
}, 60_000);

it("refreshes indexed ancestry after late retention without caching rolled-back history", async () => {
  const { a, c, first, second } = fixture();
  const genesis = a.authority.directory(a.owner, first.document.parent!)!;
  const head = directoryDigest(second.document),
    old = directoryDigest(genesis.document);
  await Promise.resolve();
  expect(c.authority.ancestor(c.owner, head, old)).toBe(false);
  expect(() =>
    c.db.transaction(() => {
      expect(c.authority.retainAncestors(c.owner, [first, genesis])).toBe(true);
      expect(c.authority.ancestor(c.owner, head, old)).toBe(true);
      throw new Error("Fixture rollback");
    })(),
  ).toThrow("Fixture rollback");
  await Promise.resolve();
  expect(c.authority.ancestor(c.owner, head, old)).toBe(false);
  expect(c.authority.retainAncestors(c.owner, [first, genesis])).toBe(true);
  expect(c.authority.ancestor(c.owner, head, old)).toBe(true);
  expect(() => c.authority.ancestor(a.owner, head, old)).toThrow();
  const recovery = c.authority.recover(c.owner, {
    mutationId: randomUUID(),
    expected: head,
    name: "Recovery",
    origin: c.origin,
    scope: [...scope],
  });
  await Promise.resolve();
  expect(
    c.authority.ancestor(c.owner, directoryDigest(recovery.document), old),
  ).toBe(false);
});

it("reports a directly named missing predecessor after another authority instance installs consent", () => {
  const a = machine(),
    b = machine();
  const reader = new FleetAuthority(b.db, secrets);
  a.authority.create(a.owner, {
    mutationId: randomUUID(),
    name: "A",
    origin: a.origin,
    scope: [...scope],
  });
  const accepted = enroll(a, b);
  const sync = new FleetDirectorySync(b.db, reader, b.owner, secrets);
  expect(() => sync.history(history(a, b, accepted.document.parent))).toThrow(
    "not stored",
  );
});

it("pages large signed rosters below the signing and transport body limits", () => {
  const { a, b } = fixture();
  const members = [...a.authority.directory(a.owner)!.document.members];
  for (let i = members.length; i < 128; i++) {
    members.push({
      ...generateMachineKey().identity,
      grantId: randomUUID(),
      name: "Large roster",
      origin: `https://peer-${i}.${("a".repeat(50) + ".").repeat(36)}example`,
    });
  }
  for (let i = 0; i < 5; i++) revise(a, members);
  const page = a.sync.history(history(b, a));
  expect(page.page.entries.length).toBeLessThan(5);
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(800_000);
  expect(page.page.next).not.toBeNull();
  const next = a.sync.history(history(b, a, page.page.next));
  expect(directoryDigest(next.page.entries[0].document)).toBe(page.page.next);
});

it("rejects conflicting successors and verifies the entire batch before any grant changes", () => {
  const { a, b, c, first, second } = fixture();
  const third = revise(
    a,
    second.document.members.map((m) => ({ ...m, name: "New label" })),
  );
  const fourth = revise(a, third.document.members);
  const damaged = { ...fourth, signature: second.signature };
  expect(() =>
    b.sync.receive(push(a, b, first, [second, third, damaged])),
  ).toThrow("signature");
  expect(b.authority.status(b.owner).head).toBe(
    directoryDigest(first.document),
  );
  b.sync.receive(push(c, b, first, [second]));
  const key = a.db
    .prepare("SELECT private_key FROM fleet_machine_identity")
    .get() as { private_key: string };
  const document = { ...second.document, mutationId: randomUUID() };
  const fork = {
    document,
    signature: signDirectory(
      document,
      secrets.unseal(
        key.private_key,
        `fleet:machine:${a.authority.identity.machineId}`,
      ),
    ),
    acceptance: null,
  };
  expect(() => b.sync.receive(push(a, b, first, [fork]))).toThrow(
    "lineage conflict",
  );
  expect(b.authority.status(b.owner).head).toBe(
    directoryDigest(second.document),
  );
});

it("limits removed senders to their removal proof and refuses their old directory pushes", () => {
  const { a, b, c, first, second } = fixture();
  b.sync.receive(push(c, b, first, [second]));
  const removed = revise(
    a,
    second.document.members.filter(
      (m) => m.machineId !== c.authority.identity.machineId,
    ),
  );
  b.sync.receive(push(a, b, second, [removed]));
  const response = b.sync.history(history(c, b));
  expect(response.page.head).toBe(directoryDigest(removed.document));
  expect(response.page.entries[0]).toEqual(removed);
  expect(() => b.sync.receive(push(c, b, first, [second]))).toThrow("outside");
  expect(b.sync.receive(push(a, b, second, [removed])).ack.head).toBe(
    directoryDigest(removed.document),
  );
});

it("acknowledges its own removal without accepting later updates or reviving an old grant", () => {
  const { a, b, c, first, second } = fixture();
  const removed = revise(
    a,
    second.document.members.filter(
      (m) => m.machineId !== b.authority.identity.machineId,
    ),
  );
  const later = revise(a, removed.document.members);
  const request = push(a, b, first, [second, removed, later]);
  const response = b.sync.receive(request);
  expect(verifyFleetDirectoryAck(request, first, response)).toEqual(response);
  expect(response.ack.state).toBe("removed");
  expect(response.ack.requested).toBe(directoryDigest(later.document));
  expect(response.ack.accepted).toBe(directoryDigest(removed.document));
  expect(response.ack.head).toBe(directoryDigest(removed.document));
  expect(
    b.db
      .prepare("SELECT count(*) n FROM fleet_peer_grants WHERE active=1")
      .get(),
  ).toEqual({ n: 0 });
  expect(() => b.sync.history(history(c, b))).toThrow("outside");
  b.sync.receive(push(a, b, first, [second]));
  expect(b.authority.status(b.owner).state).toBe("removed");
});

it("refuses implicit enrollment and mismatched identities at the production replica boundary", () => {
  const { a, b, first, second } = fixture();
  const outsider = machine();
  expect(() =>
    outsider.sync.receive(push(a, outsider, first, [second])),
  ).toThrow("completed local enrollment");
  const request = push(a, b, first, [second]);
  expect(() =>
    b.sync.receive({
      ...request,
      push: { ...request.push, destination: outsider.authority.identity },
    }),
  ).toThrow("outside");
  expect(() =>
    b.sync.receive({
      ...request,
      push: {
        ...request.push,
        sender: {
          ...a.authority.identity,
          publicKey: outsider.authority.identity.publicKey,
        },
      },
    }),
  ).toThrow("outside");
  expect(() =>
    b.sync.receive({ ...request, owner: outsider.owner } as never),
  ).toThrow();
  expect(b.authority.status(b.owner).head).toBe(
    directoryDigest(first.document),
  );
});

it("keeps recovery as an explicit consent boundary rather than an ordinary relay successor", () => {
  const { a, b, c, first, second } = fixture();
  b.sync.receive(push(c, b, first, [second]));
  const recovered = b.authority.recover(b.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(second.document),
    name: "Recovered",
    origin: b.origin,
    scope: [...scope],
  });
  const d = machine();
  const joined = enroll(b, d);
  const query = history(d, b),
    response = b.sync.history(query);
  expect(response.page.entries).toEqual([joined, recovered]);
  expect(response.page.next).toBeNull();
  expect(recovered.document.parent).toBe(directoryDigest(second.document));
  expect(verifyFleetHistoryResponse(query, response)).toEqual(response);
  for (const prior of [first, second])
    expect(() =>
      b.sync.history(history(d, b, directoryDigest(prior.document))),
    ).toThrow("outside");
  expect(
    b.sync.history(history(d, b, directoryDigest(recovered.document))).page
      .entries,
  ).toEqual([recovered]);
  for (const excluded of [a, c])
    expect(() => b.sync.receive(push(excluded, b, first, [second]))).toThrow(
      "outside",
    );
  expect(b.authority.status(b.owner).head).toBe(
    directoryDigest(joined.document),
  );
  expect(() =>
    a.sync.receive(push(b, a, second, [recovered, joined])),
  ).toThrow();
  expect(a.authority.status(a.owner).state).toBe("controller");
  expect(a.authority.status(a.owner).head).toBe(
    directoryDigest(second.document),
  );
});
