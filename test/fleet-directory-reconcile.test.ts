import { afterAll, expect, it } from "vitest";
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations } from "../src/server/migrations.js";
import { FleetAuthority } from "../src/server/fleet-authority.js";
import { FleetDirectorySync } from "../src/server/fleet-directory-sync.js";
import {
  FleetDirectoryReconcile,
  type FleetHistoryTransport,
} from "../src/server/fleet-directory-reconcile.js";
import { directoryDigest } from "../src/server/fleet-crypto.js";
import { FleetProof } from "../src/server/fleet-proof.js";
import { secret } from "../src/state.js";
import type { SignedFleetDirectory } from "../src/shared/fleet.js";

const root = mkdtempSync(join(tmpdir(), "loop-directory-reconcile-"));
process.env.LOOP_PROFILE = "companion";
process.env.LOOP_DATA_DIR = root;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const secrets = await import("../src/server/secrets.js");
const databases: Database.Database[] = [];
afterAll(() => {
  for (const db of databases) if (db.open) db.close();
  rmSync(root, { recursive: true, force: true });
});
function machine() {
  const owner = randomUUID(),
    db = new Database(join(root, `${owner}.db`));
  databases.push(db);
  applyMigrations(db);
  db.prepare("INSERT INTO deployment_profile VALUES(1,'companion')").run();
  const authority = new FleetAuthority(db, secrets);
  return {
    owner,
    db,
    authority,
    sync: new FleetDirectorySync(db, authority, owner, secrets),
    origin: `https://${owner}.example`,
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
  const directory = revise(a, [
    ...a.authority.directory(a.owner)!.document.members,
    { ...b.authority.identity, grantId, name: "Same label", origin: b.origin },
  ]);
  b.authority.approve(b.owner, {
    mutationId: randomUUID(),
    expected: null,
    kind: "enroll",
    grantId,
    scope: ["read", "events"],
    controller: a.authority.identity,
    directory,
  });
  return directory;
}
function fixture() {
  const a = machine(),
    b = machine(),
    c = machine();
  a.authority.create(a.owner, {
    mutationId: randomUUID(),
    name: "Same label",
    origin: a.origin,
    scope: ["read", "events"],
  });
  enroll(a, b);
  const initial = enroll(a, c);
  b.authority.accept(b.owner, initial);
  return { a, b, c, initial };
}
function resolver(
  local: Machine,
  remote: Machine,
  transport?: FleetHistoryTransport,
) {
  return new FleetDirectoryReconcile(
    local.db,
    local.authority,
    local.owner,
    secrets,
    transport ?? {
      history: async (_origin, query) => remote.sync.history(query),
    },
  );
}

it("retrieves multiple signed pages from a noncontroller replica and atomically updates scoped grants", async () => {
  const { a, b, c } = fixture();
  // Batch fixture setup; synchronization below still uses the production
  // transaction boundary. Individual setup fsyncs are unrelated to this case.
  a.db.transaction(() =>
    c.db.transaction(() => {
      for (let i = 0; i < 70; i++) c.authority.accept(c.owner, revise(a));
    })(),
  )();
  let calls = 0;
  const r = resolver(b, c, {
    history: async (origin, query) => {
      calls++;
      expect(origin).toBe(c.origin);
      return c.sync.history(query);
    },
  });
  expect(await r.from(c.authority.identity.machineId)).toBe(true);
  expect(calls).toBe(3);
  expect(b.authority.status(b.owner).head).toBe(
    c.authority.status(c.owner).head,
  );
  const grants = b.db
    .prepare(
      "SELECT scope,owner_id,active FROM fleet_peer_grants WHERE active=1",
    )
    .all() as { scope: string; owner_id: string; active: number }[];
  expect(grants).toHaveLength(2);
  expect(
    grants.every(
      (g) => g.owner_id === b.owner && g.scope === '["read","events"]',
    ),
  ).toBe(true);
  expect(await r.from(c.authority.identity.machineId)).toBe(false);
});

it("synchronizes exactly 1,024 missing revisions including the final trusted anchor", async () => {
  const { a, b, c, initial } = fixture();
  a.db.transaction(() =>
    c.db.transaction(() => {
      for (let i = 0; i < 1024; i++) c.authority.accept(c.owner, revise(a));
    })(),
  )();
  let calls = 0;
  const reconcile = resolver(b, c, {
    history: async (_origin, request) => {
      calls++;
      return c.sync.history(request);
    },
  });
  expect(await reconcile.from(c.authority.identity.machineId)).toBe(true);
  expect(calls).toBe(33);
  expect(b.authority.status(b.owner).head).toBe(
    c.authority.status(c.owner).head,
  );
  const query = {
    version: 1 as const,
    nonce: secret(),
    sender: b.authority.identity,
    destination: c.authority.identity,
    cursor: initial.document.parent,
  };
  const proof = new FleetProof(b.db, b.authority.identity, secrets);
  expect(() =>
    c.sync.history({ query, signature: proof.sign("directory-query", query) }),
  ).toThrow("outside");
}, 60_000);

it("a corrupt late page leaves the original head and all grants unchanged", async () => {
  const { a, b, c, initial } = fixture();
  for (let i = 0; i < 35; i++) c.authority.accept(c.owner, revise(a));
  let calls = 0;
  const before = b.db
    .prepare("SELECT * FROM fleet_peer_grants ORDER BY peer_id")
    .all();
  const r = resolver(b, c, {
    history: async (_origin, query) => {
      const response = c.sync.history(query);
      calls++;
      if (calls === 2)
        response.signature = response.signature.replace(
          /^./,
          response.signature[0] === "A" ? "B" : "A",
        );
      return response;
    },
  });
  await expect(r.from(c.authority.identity.machineId)).rejects.toThrow();
  expect(calls).toBe(2);
  expect(b.authority.status(b.owner).head).toBe(
    directoryDigest(initial.document),
  );
  expect(
    b.db.prepare("SELECT * FROM fleet_peer_grants ORDER BY peer_id").all(),
  ).toEqual(before);
});

it("a local recovery during the history read fences the old callback", async () => {
  const { a, b, c } = fixture();
  c.authority.accept(c.owner, revise(a));
  let recovered!: SignedFleetDirectory;
  const r = resolver(b, c, {
    history: async (_origin, query) => {
      const response = c.sync.history(query);
      recovered = b.authority.recover(b.owner, {
        mutationId: randomUUID(),
        expected: b.authority.status(b.owner).head!,
        name: "Recovered",
        origin: b.origin,
        scope: ["read"],
      });
      return response;
    },
  });
  await expect(r.from(c.authority.identity.machineId)).rejects.toThrow(
    /changed/,
  );
  expect(b.authority.status(b.owner).head).toBe(
    directoryDigest(recovered.document),
  );
  expect(b.authority.status(b.owner).state).toBe("controller");
});

it("a foreign recovery remains an explicit consent boundary regardless of epoch", async () => {
  const { b, c, initial } = fixture();
  c.authority.recover(c.owner, {
    mutationId: randomUUID(),
    expected: c.authority.status(c.owner).head!,
    name: "Recovered",
    origin: c.origin,
    scope: ["read"],
  });
  // The remote now refuses B before returning a page: its reset did not enroll B.
  await expect(
    resolver(b, c).from(c.authority.identity.machineId),
  ).rejects.toThrow();
  expect(b.authority.status(b.owner).head).toBe(
    directoryDigest(initial.document),
  );
});

it("cancellation and unrelated peers cannot change state or issue another request", async () => {
  const { b, c, initial } = fixture();
  let calls = 0;
  const r = resolver(b, c, {
    history: async (_origin, query) => {
      calls++;
      return c.sync.history(query);
    },
  });
  const controller = new AbortController();
  controller.abort();
  await expect(
    r.from(c.authority.identity.machineId, controller.signal),
  ).rejects.toThrow();
  await expect(r.from(b.authority.identity.machineId)).rejects.toThrow();
  await expect(
    r.from(machine().authority.identity.machineId),
  ).rejects.toThrow();
  expect(calls).toBe(0);
  expect(b.authority.status(b.owner).head).toBe(
    directoryDigest(initial.document),
  );
});

it("shared refresh tries another replica after the controller becomes unavailable", async () => {
  const { a, b, c } = fixture();
  c.authority.accept(c.owner, revise(a));
  let calls = 0;
  const r = resolver(b, c, {
    history: async (origin, query) => {
      calls++;
      if (origin === a.origin) throw new Error("unreachable");
      return c.sync.history(query);
    },
  });
  const one = r.any(),
    two = r.any();
  expect(one).toBe(two);
  expect(await one).toBe(true);
  expect(await two).toBe(true);
  expect(calls).toBe(2);
  expect(b.authority.status(b.owner).head).toBe(
    c.authority.status(c.owner).head,
  );
});

it("bounds concurrent history reads and shutdown rejects late uncooperative replies", async () => {
  const { a, b, c, initial } = fixture();
  c.authority.accept(c.owner, revise(a));
  const replies: (() => void)[] = [];
  const r = resolver(b, c, {
    history: (_origin, query) =>
      new Promise((resolve) => {
        const response = c.sync.history(query);
        replies.push(() => resolve(response));
      }),
  });
  const first = r.from(c.authority.identity.machineId);
  const second = r.from(c.authority.identity.machineId);
  const settled = Promise.allSettled([first, second]);
  await expect(r.from(c.authority.identity.machineId)).rejects.toThrow(/busy/);
  expect(replies).toHaveLength(2);
  r.close();
  expect((await settled).every((result) => result.status === "rejected")).toBe(
    true,
  );
  replies.forEach((reply) => reply());
  await Promise.resolve();
  expect(b.authority.status(b.owner).head).toBe(
    directoryDigest(initial.document),
  );
  await expect(r.from(c.authority.identity.machineId)).rejects.toThrow();
});

it("pulls a missed removal without exposing later history or retaining active grants", async () => {
  const { a, b, c } = fixture();
  for (let i = 0; i < 35; i++) c.authority.accept(c.owner, revise(a));
  const removed = revise(
    a,
    a.authority
      .directory(a.owner)!
      .document.members.filter(
        (m) => m.machineId !== b.authority.identity.machineId,
      ),
  );
  c.authority.accept(c.owner, removed);
  for (let i = 0; i < 35; i++) c.authority.accept(c.owner, revise(a));
  const later = c.authority.status(c.owner).head!;
  const r = resolver(b, c, {
    history: async (_origin, query) => {
      const response = c.sync.history(query);
      expect(response.page.head).toBe(directoryDigest(removed.document));
      if (query.query.cursor === null)
        expect(response.page.entries[0]).toEqual(removed);
      return response;
    },
  });
  expect(await r.from(c.authority.identity.machineId)).toBe(true);
  expect(b.authority.status(b.owner).state).toBe("removed");
  expect(b.authority.status(b.owner).head).toBe(
    directoryDigest(removed.document),
  );
  expect(b.authority.directory(b.owner, later)).toBeUndefined();
  expect(
    b.db
      .prepare("SELECT count(*) n FROM fleet_peer_grants WHERE active=1")
      .get(),
  ).toEqual({ n: 0 });
  const query = {
    version: 1 as const,
    nonce: secret(),
    sender: b.authority.identity,
    destination: c.authority.identity,
    cursor: later,
  };
  const proof = new FleetProof(b.db, b.authority.identity, secrets);
  expect(() =>
    c.sync.history({ query, signature: proof.sign("directory-query", query) }),
  ).toThrow();
}, 10_000);

it("pins the requested history while the remote head changes between pages", async () => {
  const { a, b, c } = fixture();
  for (let i = 0; i < 35; i++) c.authority.accept(c.owner, revise(a));
  const pinned = c.authority.status(c.owner).head;
  let advanced = false;
  const r = resolver(b, c, {
    history: async (_origin, query) => {
      const response = c.sync.history(query);
      if (!advanced) {
        advanced = true;
        c.authority.accept(c.owner, revise(a));
      }
      return response;
    },
  });
  expect(await r.from(c.authority.identity.machineId)).toBe(true);
  expect(b.authority.status(b.owner).head).toBe(pinned);
  expect(c.authority.status(c.owner).head).not.toBe(pinned);
  expect(await r.from(c.authority.identity.machineId)).toBe(true);
  expect(b.authority.status(b.owner).head).toBe(
    c.authority.status(c.owner).head,
  );
}, 10_000);

it("backfills restricted removal proofs when migrating a populated predecessor schema", () => {
  const { a, b, c } = fixture();
  const removed = revise(
    a,
    a.authority
      .directory(a.owner)!
      .document.members.filter(
        (m) => m.machineId !== b.authority.identity.machineId,
      ),
  );
  c.authority.accept(c.owner, removed);
  const before = c.authority.status(c.owner);
  // These three empty/new tables and their completion row are precisely the
  // schema introduced by migration 133. Keep existing history and grants.
  c.db.exec(
    "DROP TABLE fleet_removal_history; DROP TABLE fleet_handoff_jobs; DROP TABLE fleet_handoff_instances; DELETE FROM schema_migrations WHERE name='fleet-handoff-jobs'",
  );
  applyMigrations(c.db);
  expect(c.authority.status(c.owner)).toEqual(before);
  const query = {
    version: 1 as const,
    nonce: secret(),
    sender: b.authority.identity,
    destination: c.authority.identity,
    cursor: null,
  };
  const proof = new FleetProof(b.db, b.authority.identity, secrets);
  const response = c.sync.history({
    query,
    signature: proof.sign("directory-query", query),
  });
  expect(response.page.head).toBe(directoryDigest(removed.document));
  expect(
    c.db.prepare("SELECT owner_id,peer_id FROM fleet_removal_history").all(),
  ).toEqual([{ owner_id: c.owner, peer_id: b.authority.identity.machineId }]);
});
