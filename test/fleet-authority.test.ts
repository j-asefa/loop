import { afterAll, expect, it } from "vitest";
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations } from "../src/server/migrations.js";
import { initializeFleetIdentity } from "../src/server/fleet-identity.js";
import { FleetAuthority } from "../src/server/fleet-authority.js";
import { FleetCommands } from "../src/server/fleet-commands.js";
import { ExecutionRefused } from "../src/server/execution-refusal.js";
import {
  directoryDigest,
  fleetPayloadDigest,
  signDirectory,
} from "../src/server/fleet-crypto.js";
import type {
  FleetDirectory,
  FleetGrantContext,
  FleetMember,
  FleetOperation,
  SignedFleetDirectory,
} from "../src/shared/fleet.js";

const root = mkdtempSync(join(tmpdir(), "loop-fleet-authority-"));
process.env.LOOP_DATA_DIR = root;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const secrets = await import("../src/server/secrets.js");
const databases: Database.Database[] = [];
afterAll(() => {
  for (const db of databases) if (db.open) db.close();
  rmSync(root, { recursive: true, force: true });
});
const all: FleetOperation[] = ["read", "act", "events", "mail", "files"];
function machine(
  owner: string = randomUUID(),
  path = join(root, randomUUID() + ".db"),
) {
  const db = new Database(path);
  db.pragma("foreign_keys=ON");
  db.pragma("busy_timeout=5000");
  applyMigrations(db);
  db.prepare(
    "INSERT OR IGNORE INTO deployment_profile VALUES(1,'companion')",
  ).run();
  databases.push(db);
  return { owner, db, path, authority: new FleetAuthority(db, secrets) };
}
type Machine = ReturnType<typeof machine>;
function create(a: Machine) {
  return a.authority.create(a.owner, {
    mutationId: randomUUID(),
    name: "Same name",
    origin: "https://a.example",
    scope: all,
  });
}
function member(b: Machine, origin: string): FleetMember {
  return {
    ...b.authority.identity,
    grantId: randomUUID(),
    name: "Same name",
    origin,
  };
}
function revise(a: Machine, members: FleetMember[]) {
  return a.authority.revise(a.owner, {
    mutationId: randomUUID(),
    expected: a.authority.status(a.owner).head!,
    members,
  });
}
function approve(b: Machine, signed: SignedFleetDirectory, scope = all) {
  return b.authority.approve(b.owner, {
    mutationId: randomUUID(),
    expected: null,
    kind: "enroll",
    scope,
    controller: signed.document.controller,
    directory: signed,
    grantId: signed.document.members.find(
      (m) => m.machineId === b.authority.identity.machineId,
    )!.grantId,
  });
}
function pair(scope = all) {
  const a = machine("owner-on-A"),
    b = machine("unrelated-owner-on-B");
  const first = create(a);
  const signed = revise(a, [
    ...first.document.members,
    member(b, "https://b.example"),
  ]);
  approve(b, signed, scope);
  return { a, b, signed };
}

it("observes only committed local-owner authority and coalesces nested writes through handoff fencing", async () => {
  const { a, b, signed } = pair();
  expect(() => a.authority.observe(b.owner, () => {})).toThrow(
    "no fleet grant",
  );
  const seen: { head: string | null; state: string; transaction: boolean }[] =
    [];
  const stop = a.authority.observe(a.owner, () => {
    const current = a.authority.status(a.owner);
    seen.push({
      head: current.head,
      state: current.state,
      transaction: a.db.inTransaction,
    });
  });
  const stopThrowing = a.authority.observe(a.owner, () => {
    throw new Error("Fixture observer failure");
  });
  expect(() =>
    a.db.transaction(() => {
      revise(a, signed.document.members);
      throw new Error("Fixture rollback");
    })(),
  ).toThrow("Fixture rollback");
  await Promise.resolve();
  expect(seen).toEqual([]);
  a.db.transaction(() => {
    revise(a, signed.document.members);
    revise(a, signed.document.members);
  })();
  expect(seen).toEqual([]);
  await Promise.resolve();
  expect(seen).toEqual([
    {
      head: a.authority.status(a.owner).head,
      state: "controller",
      transaction: false,
    },
  ]);
  a.authority.prepareHandoff(a.owner, {
    mutationId: randomUUID(),
    expected: a.authority.status(a.owner).head!,
    destination: b.authority.identity,
  });
  await Promise.resolve();
  expect(seen.at(-1)).toMatchObject({
    state: "handoff_pending",
    transaction: false,
  });
  stop();
  stopThrowing();
  a.authority.recover(a.owner, {
    mutationId: randomUUID(),
    expected: a.authority.status(a.owner).head!,
    name: "Recovered",
    origin: "https://recovered.example",
    scope: all,
  });
  await Promise.resolve();
  expect(seen).toHaveLength(2);
});

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
function sign(a: Machine, document: FleetDirectory): SignedFleetDirectory {
  const row = a.db
    .prepare("SELECT private_key FROM fleet_machine_identity")
    .get() as { private_key: string };
  const privateKey = secrets.unseal(
    row.private_key,
    `fleet:machine:${a.authority.identity.machineId}`,
  );
  return {
    document,
    signature: signDirectory(document, privateKey),
    acceptance: null,
  };
}

it("keeps ordinary startup standalone, scopes reads to the local owner, and persists explicit creation", () => {
  const a = machine();
  expect(a.authority.status(a.owner).state).toBe("standalone");
  expect(a.db.prepare("SELECT * FROM fleet_peer_grants").all()).toEqual([]);
  const input = {
    mutationId: randomUUID(),
    name: "A",
    origin: "https://a.example",
    scope: all,
  };
  const first = a.authority.create(a.owner, input);
  expect(a.authority.create(a.owner, input)).toEqual(first);
  expect(() =>
    a.authority.create(a.owner, { ...input, name: "different" }),
  ).toThrow("different input");
  expect(() => a.authority.directory("another owner")).toThrow(
    "no fleet grant",
  );
  expect(() => a.authority.create("another owner", input)).toThrow(
    "no fleet grant",
  );
  a.db.close();
  const restarted = machine(a.owner, a.path);
  expect(restarted.authority.status(a.owner)).toMatchObject({
    state: "controller",
    head: directoryDigest(first.document),
  });
  expect(
    restarted.db
      .prepare("SELECT kind,previous_head FROM fleet_local_consents")
      .all(),
  ).toEqual([{ kind: "create", previous_head: null }]);
  expect(restarted.db.pragma("foreign_key_check")).toEqual([]);
});

it("maps equal labels to independent owners and grants only the locally approved scope", () => {
  const { a, b, signed } = pair(["read"]);
  expect(b.authority.authorize(context(b, a)).owner).toBe(b.owner);
  expect(a.authority.authorize(context(a, b)).owner).toBe(a.owner);
  expect(() => b.authority.authorize(context(b, a, "act"))).toThrow(
    "approved scope",
  );
  expect(() =>
    b.authority.authorize({
      ...context(b, a),
      destination: a.authority.identity.machineId,
    }),
  ).toThrow("destination");
  expect(() =>
    b.authority.authorize({ ...context(b, a), grantId: randomUUID() }),
  ).toThrow("revoked");
  expect(() =>
    b.authority.authorize({
      ...context(b, a),
      owner: a.owner,
    } as FleetGrantContext),
  ).toThrow();
  expect(() =>
    b.authority.revise(b.owner, {
      mutationId: randomUUID(),
      expected: directoryDigest(signed.document),
      members: signed.document.members,
    }),
  ).toThrow("current controller");
  expect(JSON.stringify(signed)).not.toContain(a.owner);
  expect(JSON.stringify(signed)).not.toContain(b.owner);
});

it("requires local consent even for a valid controller signature, and rejects a mismatched consent", () => {
  const { a, signed } = pair();
  const c = machine();
  const joined = revise(a, [
    ...signed.document.members,
    member(c, "https://c.example"),
  ]);
  expect(() => c.authority.accept(c.owner, joined)).toThrow("local consent");
  expect(() =>
    c.authority.approve(c.owner, {
      mutationId: randomUUID(),
      expected: null,
      kind: "enroll",
      scope: all,
      controller: c.authority.identity,
      directory: joined,
      grantId: joined.document.members[2].grantId,
    }),
  ).toThrow("approved identity");
  expect(c.db.prepare("SELECT * FROM fleet_binding").all()).toEqual([]);
  expect(c.db.prepare("SELECT * FROM fleet_local_consents").all()).toEqual([]);
});

it("serializes tabs, deduplicates old mutations and refuses historical ID reuse or a fork", () => {
  const { a, b, signed } = pair();
  const input = {
    mutationId: randomUUID(),
    expected: directoryDigest(signed.document),
    members: signed.document.members.map((m) => ({ ...m, name: "changed" })),
  };
  const next = a.authority.revise(a.owner, input);
  expect(() =>
    a.authority.revise(a.owner, { ...input, mutationId: randomUUID() }),
  ).toThrow("Fleet changed");
  expect(a.authority.revise(a.owner, input)).toEqual(next);
  b.authority.accept(b.owner, next);
  const latest = revise(a, next.document.members);
  b.authority.accept(b.owner, latest);
  expect(b.authority.accept(b.owner, next)).toEqual(next);
  expect(b.authority.status(b.owner).head).toBe(
    directoryDigest(latest.document),
  );
  const duplicateId = sign(a, {
    ...latest.document,
    parent: directoryDigest(latest.document),
    revision: latest.document.revision + 1,
    mutationId: signed.document.mutationId,
  });
  expect(() => b.authority.accept(b.owner, duplicateId)).toThrow("mutation ID");
  const fork = sign(a, {
    ...next.document,
    mutationId: randomUUID(),
    members: next.document.members.map((m) => ({ ...m, name: "fork" })),
  });
  expect(() => b.authority.accept(b.owner, fork)).toThrow("lineage conflict");
  expect(b.authority.status(b.owner).head).toBe(
    directoryDigest(latest.document),
  );
});

it("updates grants atomically for joins and address repair, and tombstones removal without deleting history", () => {
  const { a, b, signed } = pair(["read", "mail"]),
    c = machine();
  const oldContext = context(b, a);
  const joined = revise(a, [
    ...signed.document.members,
    member(c, "https://c.example"),
  ]);
  b.authority.accept(b.owner, joined);
  expect(b.authority.authorize(context(b, c, "mail")).owner).toBe(b.owner);
  expect(() => b.authority.authorize(context(b, c, "act"))).toThrow(
    "approved scope",
  );
  expect(() => b.authority.authorize(oldContext)).toThrow("Synchronize");
  const repaired = revise(
    a,
    joined.document.members.map((m) =>
      m.machineId === c.authority.identity.machineId
        ? { ...m, origin: "https://c-new.example" }
        : m,
    ),
  );
  b.authority.accept(b.owner, repaired);
  expect(b.authority.authorize(context(b, c)).publicKey).toBe(
    c.authority.identity.publicKey,
  );
  const removed = revise(
    a,
    repaired.document.members.filter(
      (m) => m.machineId !== c.authority.identity.machineId,
    ),
  );
  b.authority.accept(b.owner, removed);
  expect(() => b.authority.authorize(context(b, c))).toThrow("revoked");
  expect(() => revise(a, joined.document.members)).toThrow("tombstones");
  expect(
    b.authority.directory(b.owner, directoryDigest(joined.document)),
  ).toEqual(joined);
  const noB = revise(
    a,
    removed.document.members.filter(
      (m) => m.machineId !== b.authority.identity.machineId,
    ),
  );
  b.authority.accept(b.owner, noB);
  expect(b.authority.status(b.owner).state).toBe("removed");
  expect(
    b.db.prepare("SELECT * FROM fleet_peer_grants WHERE active=1").all(),
  ).toEqual([]);
  expect(() => revise(a, [])).toThrow();
  expect(() => revise(a, [member(c, "https://c.example")])).toThrow();
});

it("fences the old controller before sending a handoff and recovers lost replies through durable receipts", () => {
  const { a, b, signed } = pair();
  const request = {
    mutationId: randomUUID(),
    expected: directoryDigest(signed.document),
    destination: b.authority.identity,
  };
  const proposal = a.authority.prepareHandoff(a.owner, request);
  expect(a.authority.status(a.owner).state).toBe("handoff_pending");
  expect(() => revise(a, signed.document.members)).toThrow(
    "current controller",
  );
  a.db.close();
  const restartedA = machine(a.owner, a.path);
  expect(restartedA.authority.status(a.owner).state).toBe("handoff_pending");
  expect(restartedA.authority.prepareHandoff(a.owner, request)).toEqual(
    proposal,
  );
  const accepted = b.authority.acceptHandoff(b.owner, proposal);
  expect(b.authority.status(b.owner).state).toBe("controller");
  b.db.close();
  const restartedB = machine(b.owner, b.path);
  expect(restartedB.authority.acceptHandoff(b.owner, proposal)).toEqual(
    accepted,
  );
  expect(restartedA.authority.status(a.owner).state).toBe("handoff_pending");
  restartedA.authority.accept(a.owner, accepted);
  expect(restartedA.authority.status(a.owner).state).toBe("replica");
  expect(() => revise(restartedA, signed.document.members)).toThrow(
    "current controller",
  );
  const next = revise(restartedB, accepted.document.members);
  expect(() =>
    restartedB.authority.prepareHandoff(b.owner, {
      mutationId: signed.document.mutationId,
      expected: directoryDigest(next.document),
      destination: restartedA.authority.identity,
    }),
  ).toThrow("mutation ID");
  expect(restartedB.authority.status(b.owner).state).toBe("controller");
  restartedA.authority.accept(a.owner, next);
  expect(restartedA.authority.status(a.owner).head).toBe(
    directoryDigest(next.document),
  );
  expect(restartedB.authority.acceptHandoff(b.owner, proposal)).toEqual(
    accepted,
  );
  expect(restartedB.authority.status(b.owner).head).toBe(
    directoryDigest(next.document),
  );
  expect(
    restartedA.db.prepare("SELECT state FROM fleet_handoffs").all(),
  ).toEqual([{ state: "committed" }]);
});

it("rejects substituted handoff destinations and never aborts a prepared transition automatically", () => {
  const { a, b, signed } = pair(),
    c = machine();
  expect(() =>
    a.authority.prepareHandoff(a.owner, {
      mutationId: randomUUID(),
      expected: directoryDigest(signed.document),
      destination: c.authority.identity,
    }),
  ).toThrow("enrolled");
  const proposal = a.authority.prepareHandoff(a.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(signed.document),
    destination: b.authority.identity,
  });
  expect(() => c.authority.acceptHandoff(c.owner, proposal)).toThrow(
    "enrolled",
  );
  const changed = {
    ...proposal,
    document: { ...proposal.document, mutationId: randomUUID() },
  };
  expect(() => b.authority.acceptHandoff(b.owner, changed)).toThrow(
    "signature",
  );
  expect(b.authority.status(b.owner).state).toBe("replica");
  const unfenced = sign(a, {
    ...signed.document,
    parent: directoryDigest(signed.document),
    revision: signed.document.revision + 1,
    mutationId: randomUUID(),
  });
  expect(() => a.authority.accept(a.owner, unfenced)).toThrow(
    "prepared controller handoff",
  );
  expect(a.authority.status(a.owner).state).toBe("handoff_pending");
});

it("resets authority only through new local consent and leaves unconfirmed members on their old lineage", () => {
  const { a, b, signed } = pair(),
    c = machine("owner-on-C");
  const joined = revise(a, [
    ...signed.document.members,
    member(c, "https://c.example"),
  ]);
  b.authority.accept(b.owner, joined);
  approve(c, joined);
  const oldB = context(b, a),
    prior = directoryDigest(joined.document);
  const bMember = { ...joined.document.members[1], grantId: randomUUID() };
  const document: FleetDirectory = {
    ...joined.document,
    kind: "recovery",
    parent: prior,
    epoch: joined.document.epoch + 1,
    revision: 0,
    mutationId: randomUUID(),
    controller: b.authority.identity,
    members: [bMember],
  };
  const recovery = sign(b, document);
  expect(() => b.authority.accept(b.owner, recovery)).toThrow("local consent");
  expect(() => c.authority.accept(c.owner, recovery)).toThrow("local consent");
  const consent = {
    mutationId: randomUUID(),
    expected: prior,
    kind: "recover" as const,
    grantId: bMember.grantId,
    scope: all,
    controller: b.authority.identity,
    directory: recovery,
  };
  b.authority.approve(b.owner, consent);
  expect(b.authority.approve(b.owner, consent)).toEqual(recovery);
  expect(b.authority.status(b.owner).state).toBe("controller");
  expect(c.authority.status(c.owner)).toMatchObject({
    state: "replica",
    head: prior,
  });
  expect(a.authority.status(a.owner).state).toBe("controller"); // A is still partitioned; no global consensus is claimed.
  expect(() => b.authority.authorize(oldB)).toThrow("revoked");
  const stale = revise(a, joined.document.members);
  expect(() => b.authority.accept(b.owner, stale)).toThrow("lineage conflict");
  const cMember = { ...joined.document.members[2], grantId: randomUUID() };
  const rejoined = revise(b, [...recovery.document.members, cMember]);
  expect(() => c.authority.accept(c.owner, rejoined)).toThrow(
    "lineage conflict",
  );
  c.authority.approve(c.owner, {
    mutationId: randomUUID(),
    expected: prior,
    kind: "recover",
    grantId: cMember.grantId,
    scope: ["read"],
    controller: b.authority.identity,
    directory: rejoined,
  });
  expect(c.authority.authorize(context(c, b)).owner).toBe(c.owner);
  expect(() => c.authority.authorize(context(c, a))).toThrow("revoked");
  expect(
    c.db
      .prepare(
        "SELECT previous_head FROM fleet_local_consents WHERE kind='recover'",
      )
      .get(),
  ).toEqual({ previous_head: prior });
  expect(c.authority.directory(c.owner, prior)).toEqual(joined);
});

it("rolls back directory acceptance and grant changes together on storage failure", () => {
  const { a, b, signed } = pair(),
    c = machine();
  const joined = revise(a, [
    ...signed.document.members,
    member(c, "https://c.example"),
  ]);
  b.db.exec(
    "CREATE TRIGGER fixture_fail_grant BEFORE INSERT ON fleet_peer_grants BEGIN SELECT RAISE(ABORT,'fixture grant failure'); END",
  );
  expect(() => b.authority.accept(b.owner, joined)).toThrow(
    "fixture grant failure",
  );
  expect(b.authority.status(b.owner).head).toBe(
    directoryDigest(signed.document),
  );
  expect(
    b.authority.directory(b.owner, directoryDigest(joined.document)),
  ).toBeUndefined();
  expect(b.authority.authorize(context(b, a)).owner).toBe(b.owner);
});

it("refuses preview isolation before creating a fleet identity", () => {
  const db = new Database(":memory:");
  databases.push(db);
  applyMigrations(db);
  expect(() => new FleetAuthority(db, secrets, { isolated: true })).toThrow();
  expect(db.prepare("SELECT * FROM fleet_machine_identity").all()).toEqual([]);
  expect(db.prepare("SELECT * FROM fleet_binding").all()).toEqual([]);
});

it("records a destination intent before dispatch, projects safe results, and deduplicates across gateways", async () => {
  const { a, b, signed } = pair(),
    c = machine();
  const joined = revise(a, [
    ...signed.document.members,
    member(c, "https://c.example"),
  ]);
  b.authority.accept(b.owner, joined);
  const commands = new FleetCommands(b.db, b.authority),
    commandId = randomUUID();
  const output = z.object({ id: z.string() });
  let effects = 0,
    finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const first = commands.execute(
    context(b, a, "act"),
    commandId,
    { text: "hello", generation: "g1" },
    output,
    async (owner, originalId) => {
      expect(owner).toBe(b.owner);
      expect(originalId).toBe(commandId);
      effects++;
      expect(
        b.db
          .prepare(
            "SELECT state FROM fleet_command_receipts WHERE command_id=?",
          )
          .get(commandId),
      ).toEqual({ state: "started" });
      await gate;
      return { id: "created-run", privateKey: "fixture-never-project" };
    },
  );
  const retry = commands.execute(
    context(b, c, "act"),
    commandId,
    { generation: "g1", text: "hello" },
    output,
    async () => {
      throw new Error("duplicate effect");
    },
  );
  expect(commands.receipt(context(b, c, "act"), commandId)?.state).toBe(
    "started",
  );
  finish();
  const result = await first;
  expect(await retry).toEqual(result);
  expect(result).toEqual({
    commandId,
    state: "completed",
    result: { id: "created-run" },
  });
  expect(effects).toBe(1);
  expect(
    JSON.stringify(b.db.prepare("SELECT * FROM fleet_command_receipts").all()),
  ).not.toContain("fixture-never-project");
  expect(
    new FleetCommands(b.db, b.authority).receipt(
      context(b, c, "act"),
      commandId,
    ),
  ).toEqual(result);
  await expect(
    commands.execute(
      context(b, c, "act"),
      commandId,
      { generation: "g2", text: "hello" },
      output,
      async () => ({}),
    ),
  ).rejects.toThrow("different input");
});

it("never replays an effect when its process exits before recording completion", async () => {
  const { a, b } = pair(),
    commandId = randomUUID(),
    request = { input: "one effect" };
  const input = context(b, a, "act");
  b.db.exec("CREATE TABLE fixture_effects(id INTEGER PRIMARY KEY)");
  const script = `
    import Database from 'better-sqlite3'; import {z} from 'zod';
    import {FleetAuthority} from './src/server/fleet-authority.ts';
    import {FleetCommands} from './src/server/fleet-commands.ts';
    import {seal,unseal} from './src/server/secrets.ts';
    const db=new Database(${JSON.stringify(b.path)});
    const commands=new FleetCommands(db,new FleetAuthority(db,{seal,unseal}));
    await commands.execute(${JSON.stringify(input)},${JSON.stringify(commandId)},${JSON.stringify(request)},z.object({ok:z.boolean()}),async()=>{
      db.prepare('INSERT INTO fixture_effects DEFAULT VALUES').run(); process.exit(0);
    });
  `;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("LOOP_")),
  );
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    {
      encoding: "utf8",
      timeout: 15000,
      env: {
        ...env,
        LOOP_DATA_DIR: root,
        LOOP_ENCRYPTION_KEY: process.env.LOOP_ENCRYPTION_KEY,
      },
    },
  );
  expect(child.status, child.stderr).toBe(0);
  b.db.close();
  const restarted = machine(b.owner, b.path),
    commands = new FleetCommands(restarted.db, restarted.authority);
  expect(commands.receipt(input, commandId)?.state).toBe("unknown");
  expect(
    await commands.execute(
      input,
      commandId,
      request,
      z.object({ ok: z.boolean() }),
      async () => {
        restarted.db
          .prepare("INSERT INTO fixture_effects DEFAULT VALUES")
          .run();
        return { ok: true };
      },
    ),
  ).toEqual({ commandId, state: "unknown", result: null });
  expect(
    restarted.db.prepare("SELECT count(*) n FROM fixture_effects").get(),
  ).toEqual({ n: 1 });
  expect(
    restarted.db.prepare("SELECT state FROM fleet_command_receipts").get(),
  ).toEqual({ state: "started" });
});

it("rechecks removal before dispatch and preserves a definite generation refusal without replay", async () => {
  const { a, b, signed } = pair(),
    c = machine();
  const joined = revise(a, [
    ...signed.document.members,
    member(c, "https://c.example"),
  ]);
  b.authority.accept(b.owner, joined);
  const commands = new FleetCommands(b.db, b.authority),
    commandId = randomUUID();
  let effects = 0;
  const pending = commands.execute(
    context(b, c, "act"),
    commandId,
    {},
    z.object({}),
    async () => {
      effects++;
      return {};
    },
  );
  b.authority.accept(b.owner, revise(a, signed.document.members));
  expect((await pending).state).toBe("refused");
  expect(effects).toBe(0);
  const staleId = randomUUID(),
    ctx = context(b, a, "act");
  expect(
    (
      await commands.execute(
        ctx,
        staleId,
        { generation: "old" },
        z.object({}),
        async () => {
          throw new ExecutionRefused(409, "Stale native decision generation");
        },
      )
    ).state,
  ).toBe("refused");
  expect(
    (
      await commands.execute(
        ctx,
        staleId,
        { generation: "old" },
        z.object({}),
        async () => {
          effects++;
          return {};
        },
      )
    ).state,
  ).toBe("refused");
  expect(effects).toBe(0);
});

it("preserves uncertainty without persisting requests or unprojected failures", async () => {
  const { a, b } = pair(),
    commands = new FleetCommands(b.db, b.authority),
    commandId = randomUUID();
  const ctx = context(b, a, "act");
  let effects = 0;
  const run = () =>
    commands.execute(
      ctx,
      commandId,
      { text: "fixture-private-request" },
      z.object({ ok: z.boolean() }),
      async () => {
        effects++;
        throw new Error("fixture-private-provider-failure");
      },
    );
  expect((await run()).state).toBe("unknown");
  expect((await run()).state).toBe("unknown");
  expect(effects).toBe(1);
  const stored = JSON.stringify(
    b.db.prepare("SELECT * FROM fleet_command_receipts").all(),
  );
  expect(stored).not.toContain("fixture-private");
});

it("bounds cached result bodies while retaining completed command identities", async () => {
  const { a, b } = pair(),
    commands = new FleetCommands(b.db, b.authority),
    ctx = context(b, a, "act");
  let effects = 0;
  const ids: string[] = [];
  for (let i = 0; i < 65; i++) {
    const id = randomUUID();
    ids.push(id);
    await commands.execute(
      ctx,
      id,
      { i },
      z.object({ id: z.number() }),
      async () => {
        effects++;
        return { id: i };
      },
    );
  }
  expect(
    b.db
      .prepare(
        "SELECT count(*) n FROM fleet_command_receipts WHERE result IS NOT NULL",
      )
      .get(),
  ).toEqual({ n: 64 });
  expect(
    await commands.execute(
      ctx,
      ids[0],
      { i: 0 },
      z.object({ id: z.number() }),
      async () => {
        effects++;
        return { id: 0 };
      },
    ),
  ).toEqual({ commandId: ids[0], state: "completed", result: null });
  expect(effects).toBe(65);
});

it("binds local recovery to the owner and the action saved before execution, including after removal", async () => {
  const { a, b, signed } = pair();
  const commands = new FleetCommands(b.db, b.authority),
    id = randomUUID();
  const input = { route: "agentCreate", body: { name: "fixture" } };
  const digest = fleetPayloadDigest(input);
  let effects = 0;
  const receipt = await commands.execute(
    context(b, a, "act"),
    id,
    input,
    z.object({ id: z.string() }),
    async () => {
      expect(
        b.db
          .prepare(
            "SELECT state,command_tag,payload_digest FROM fleet_command_receipts WHERE owner_id=? AND command_id=?",
          )
          .get(b.owner, id),
      ).toEqual({
        state: "started",
        command_tag: "agentCreate",
        payload_digest: digest,
      });
      effects++;
      return { id: "created" };
    },
    "agentCreate",
  );
  expect(commands.localReceipt(b.owner, id, digest, "agentCreate")).toEqual(
    receipt,
  );
  expect(commands.localReceipt(a.owner, id, digest, "agentCreate")).toBeNull();
  expect(() =>
    commands.localReceipt(b.owner, id, digest, "agentUpdate"),
  ).toThrow(/different command or action/);
  await expect(
    commands.execute(
      context(b, a, "act"),
      id,
      input,
      z.object({ id: z.string() }),
      async () => {
        effects++;
        return { id: "duplicate" };
      },
      "agentUpdate",
    ),
  ).rejects.toMatchObject({ status: 409 });
  const removed = revise(
    a,
    signed.document.members.filter(
      (m) => m.machineId !== b.authority.identity.machineId,
    ),
  );
  b.authority.accept(b.owner, removed);
  expect(() =>
    commands.receipt(context(b, a, "act"), id, digest, "agentCreate"),
  ).toThrow();
  expect(commands.localReceipt(b.owner, id, digest, "agentCreate")).toEqual(
    receipt,
  );
  expect(effects).toBe(1);
});

it("upgrades old command receipts without inventing their action or losing uncertain outcomes", () => {
  const previous = join(root, "pre-command-tags-migrations");
  mkdirSync(previous);
  const migrations = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(migrations))
    if (Number(name.split("-")[0]) < 137)
      copyFileSync(new URL(name, migrations), join(previous, name));
  const db = new Database(join(root, "old-commands.db"));
  databases.push(db);
  applyMigrations(db, previous);
  db.prepare("INSERT INTO deployment_profile VALUES(1,'companion')").run();
  const owner = randomUUID(),
    id = randomUUID(),
    digest = "a".repeat(64);
  db.prepare(
    "INSERT INTO fleet_command_receipts VALUES(?,?,?,?,?,? ,?,'unknown',NULL,1,1)",
  ).run(owner, "old-peer", id, "old-fleet", "old-grant", "act", digest);
  applyMigrations(db);
  const commands = new FleetCommands(db, new FleetAuthority(db, secrets));
  expect(commands.localReceipt(owner, id, digest, "agentCreate")).toEqual({
    commandId: id,
    state: "unknown",
    result: null,
  });
  db.prepare(
    "UPDATE fleet_command_receipts SET state='completed',result=? WHERE command_id=?",
  ).run(JSON.stringify({ privateUntypedResult: "must not escape" }), id);
  expect(commands.localReceipt(owner, id, digest, "agentCreate")).toEqual({
    commandId: id,
    state: "completed",
    result: null,
  });
  expect(() =>
    commands.localReceipt(owner, id, "b".repeat(64), "agentCreate"),
  ).toThrow();
  expect(
    commands.localReceipt(randomUUID(), id, digest, "agentCreate"),
  ).toBeNull();
  expect(
    db
      .prepare(
        "SELECT state,command_tag,payload_digest FROM fleet_command_receipts WHERE command_id=?",
      )
      .get(id),
  ).toEqual({ state: "completed", command_tag: null, payload_digest: digest });
});

it("migrates an existing companion without changing its identity or workspace records", () => {
  const previous = join(root, "pre-authority-migrations");
  mkdirSync(previous);
  const migrations = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(migrations))
    if (Number(name.split("-")[0]) < 128)
      copyFileSync(new URL(name, migrations), join(previous, name));
  const db = new Database(join(root, "upgrade.db"));
  databases.push(db);
  db.pragma("foreign_keys=ON");
  applyMigrations(db, previous);
  db.prepare("INSERT INTO deployment_profile VALUES(1,'companion')").run();
  db.prepare(
    "INSERT INTO folders(id,owner_id,parent_id,kind,name,created_at) VALUES('kept','existing-owner',NULL,'folder','Keep me',1)",
  ).run();
  const identity = initializeFleetIdentity(db, secrets);
  applyMigrations(db);
  const authority = new FleetAuthority(db, secrets);
  expect(authority.identity).toEqual(identity);
  expect(authority.status("existing-owner").state).toBe("standalone");
  expect(db.prepare("SELECT name FROM folders WHERE id='kept'").get()).toEqual({
    name: "Keep me",
  });
  expect(db.prepare("SELECT * FROM fleet_peer_grants").all()).toEqual([]);
  expect(db.pragma("foreign_key_check")).toEqual([]);
});

it("starts explicit controller recovery with only the locally confirmed member and a new grant", () => {
  const { a, b, signed } = pair();
  const input = {
    mutationId: randomUUID(),
    expected: directoryDigest(signed.document),
    name: "B",
    origin: "https://b-recovered.example",
    scope: all,
  };
  const recovered = b.authority.recover(b.owner, input);
  expect(b.authority.recover(b.owner, input)).toEqual(recovered);
  expect(recovered.document).toMatchObject({
    kind: "recovery",
    epoch: 1,
    revision: 0,
    parent: input.expected,
    controller: b.authority.identity,
  });
  expect(recovered.document.members).toHaveLength(1);
  expect(recovered.document.members[0].grantId).not.toBe(
    signed.document.members[1].grantId,
  );
  expect(
    b.db.prepare("SELECT * FROM fleet_peer_grants WHERE active=1").all(),
  ).toEqual([]);
  expect(a.authority.status(a.owner).state).toBe("controller");
  expect(() => a.authority.accept(a.owner, recovered)).toThrow("local consent");
});

it("requires consent to replace an incompatible higher-numbered epoch instead of electing a numeric winner", () => {
  const { a, b, signed } = pair(),
    c = machine();
  const joined = revise(a, [
    ...signed.document.members,
    member(c, "https://c.example"),
  ]);
  approve(c, joined);
  const oldGrant = randomUUID();
  const incompatible = sign(a, {
    ...signed.document,
    kind: "recovery",
    epoch: 20,
    revision: 0,
    parent: directoryDigest(signed.document),
    mutationId: randomUUID(),
    members: signed.document.members.map((m) =>
      m.machineId === b.authority.identity.machineId
        ? { ...m, grantId: oldGrant }
        : m,
    ),
  });
  b.authority.approve(b.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(signed.document),
    kind: "recover",
    grantId: oldGrant,
    scope: all,
    controller: a.authority.identity,
    directory: incompatible,
  });
  const recovered = c.authority.recover(c.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(joined.document),
    name: "C",
    origin: "https://c.example",
    scope: all,
  });
  const newMember = member(b, "https://b.example");
  const target = revise(c, [...recovered.document.members, newMember]);
  expect(target.document.epoch).toBe(1);
  expect(() => b.authority.accept(b.owner, target)).toThrow("lineage conflict");
  b.authority.approve(b.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(incompatible.document),
    kind: "recover",
    grantId: newMember.grantId,
    scope: ["read"],
    controller: c.authority.identity,
    directory: target,
  });
  expect(b.authority.authorize(context(b, c)).owner).toBe(b.owner);
  expect(() => b.authority.authorize(context(b, a))).toThrow("revoked");
});

it("refuses excess pending commands before recording another intent", async () => {
  const { a, b } = pair(),
    commands = new FleetCommands(b.db, b.authority),
    ctx = context(b, a, "act");
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const promises = Array.from({ length: 64 }, () =>
    commands.execute(ctx, randomUUID(), {}, z.object({}), async () => {
      await gate;
      return {};
    }),
  );
  const extra = randomUUID();
  await expect(
    commands.execute(ctx, extra, {}, z.object({}), async () => ({})),
  ).rejects.toThrow("busy");
  expect(
    b.db
      .prepare("SELECT * FROM fleet_command_receipts WHERE command_id=?")
      .get(extra),
  ).toBeUndefined();
  finish();
  expect(
    (await Promise.all(promises)).every((r) => r.state === "completed"),
  ).toBe(true);
});

it("refuses peer authorization and successors when persisted signing evidence is damaged", () => {
  const { a, b, signed } = pair(),
    ctx = context(b, a);
  const damaged = {
    ...signed,
    signature:
      (signed.signature[0] === "A" ? "B" : "A") + signed.signature.slice(1),
  };
  b.db
    .prepare(
      "UPDATE fleet_directory_history SET signed=? WHERE owner_id=? AND digest=?",
    )
    .run(JSON.stringify(damaged), b.owner, directoryDigest(signed.document));
  expect(() => b.authority.authorize(ctx)).toThrow("directory");
  const next = revise(a, signed.document.members);
  expect(() => b.authority.accept(b.owner, next)).toThrow("directory");
  expect(b.db.prepare("SELECT head FROM fleet_binding").get()).toEqual({
    head: directoryDigest(signed.document),
  });
  expect(
    b.db
      .prepare("SELECT digest FROM fleet_directory_history WHERE digest=?")
      .get(directoryDigest(next.document)),
  ).toBeUndefined();
});

it("never reuses a historical destination grant when explicitly resetting authority", () => {
  const { a, b, signed } = pair();
  const initialGrant = signed.document.members[1].grantId;
  const recovered = b.authority.recover(b.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(signed.document),
    name: "B",
    origin: "https://b.example",
    scope: all,
  });
  const proposal = sign(a, {
    ...signed.document,
    kind: "recovery",
    epoch: 2,
    revision: 0,
    parent: directoryDigest(recovered.document),
    mutationId: randomUUID(),
  });
  expect(() =>
    b.authority.approve(b.owner, {
      mutationId: randomUUID(),
      expected: directoryDigest(recovered.document),
      kind: "recover",
      grantId: initialGrant,
      scope: all,
      controller: a.authority.identity,
      directory: proposal,
    }),
  ).toThrow("fresh destination grant");
  expect(b.authority.status(b.owner).head).toBe(
    directoryDigest(recovered.document),
  );
});

it("refuses malformed public-key material as a safe input error before saving consent", () => {
  const a = machine(),
    b = machine();
  const initial = create(a);
  const joined = revise(a, [
    ...initial.document.members,
    member(b, "https://b.example"),
  ]);
  const malformed = {
    ...joined,
    document: {
      ...joined.document,
      members: joined.document.members.map((m) =>
        m.machineId === b.authority.identity.machineId
          ? { ...m, publicKey: "A".repeat(59) }
          : m,
      ),
    },
  };
  expect(() => approve(b, malformed)).toThrowError(
    expect.objectContaining({
      status: 400,
      message: "Invalid fleet machine key.",
    }),
  );
  expect(b.authority.status(b.owner).state).toBe("standalone");
  expect(b.db.prepare("SELECT * FROM fleet_local_consents").all()).toEqual([]);
});

it("retains explicit recovery trust anchors when a handoff names a locally known predecessor", () => {
  const { a, b, signed } = pair();
  const grantId = randomUUID();
  const document: FleetDirectory = {
    ...signed.document,
    kind: "handoff",
    epoch: 1,
    revision: 0,
    parent: directoryDigest(signed.document),
    mutationId: randomUUID(),
    controller: b.authority.identity,
    members: signed.document.members.map((m) =>
      m.machineId === b.authority.identity.machineId ? { ...m, grantId } : m,
    ),
  };
  const row = b.db
    .prepare("SELECT private_key FROM fleet_machine_identity")
    .get() as { private_key: string };
  const replacement = {
    ...sign(a, document),
    acceptance: signDirectory(
      document,
      secrets.unseal(
        row.private_key,
        `fleet:machine:${b.authority.identity.machineId}`,
      ),
      "handoff",
    ),
  };
  // A relay cannot admit the changed local grant as an ordinary succession.
  expect(() => a.authority.accept(a.owner, replacement)).toThrow(
    "lineage conflict",
  );
  b.authority.approve(b.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(signed.document),
    kind: "recover",
    grantId,
    scope: all,
    controller: b.authority.identity,
    directory: replacement,
  });
  b.db.close();
  const restarted = machine(b.owner, b.path);
  expect(restarted.authority.status(b.owner)).toMatchObject({
    state: "controller",
    head: directoryDigest(document),
  });
  expect(restarted.authority.authorize(context(restarted, a)).owner).toBe(
    b.owner,
  );
  const next = revise(restarted, document.members);
  expect(restarted.authority.directory(b.owner)).toEqual(next);
  expect(
    restarted.authority.recover(b.owner, {
      mutationId: randomUUID(),
      expected: directoryDigest(next.document),
      name: "B",
      origin: "https://b.example",
      scope: all,
    }).document.kind,
  ).toBe("recovery");
});
