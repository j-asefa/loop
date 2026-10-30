import { afterAll, expect, it } from "vitest";
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { applyMigrations } from "../src/server/migrations.js";
import { FleetAuthority } from "../src/server/fleet-authority.js";
import { FleetProof } from "../src/server/fleet-proof.js";
import { directoryDigest } from "../src/server/fleet-crypto.js";
import {
  FleetHandoffDestination,
  FleetHandoffSource,
  type FleetHandoffTransport,
} from "../src/server/fleet-handoff.js";
import type {
  FleetHandoffProposal,
  FleetOperation,
} from "../src/shared/fleet.js";
import type { SignedFleetHandoffQuery } from "../src/shared/fleet-handoff.js";

const root = mkdtempSync(join(tmpdir(), "loop55-fleet-handoff-"));
process.env.LOOP55_PROFILE = "companion";
process.env.LOOP55_DATA_DIR = root;
process.env.LOOP55_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const secrets = await import("../src/server/secrets.js");
const databases: Database.Database[] = [];
const scope: FleetOperation[] = ["read", "act", "events", "mail", "files"];
afterAll(() => {
  for (const db of databases) if (db.open) db.close();
  rmSync(root, { recursive: true, force: true });
});
function machine() {
  const owner = randomUUID(),
    db = new Database(join(root, randomUUID() + ".db"));
  databases.push(db);
  applyMigrations(db);
  db.prepare("INSERT INTO deployment_profile VALUES(1,'companion')").run();
  const authority = new FleetAuthority(db, secrets);
  return { owner, db, authority, origin: `https://${randomUUID()}.example` };
}
function fixture() {
  const a = machine(),
    b = machine();
  const genesis = a.authority.create(a.owner, {
    mutationId: randomUUID(),
    name: "Same name",
    origin: a.origin,
    scope,
  });
  const grantId = randomUUID(),
    directory = a.authority.revise(a.owner, {
      mutationId: randomUUID(),
      expected: directoryDigest(genesis.document),
      members: [
        ...genesis.document.members,
        {
          ...b.authority.identity,
          grantId,
          name: "Same name",
          origin: b.origin,
        },
      ],
    });
  b.authority.approve(b.owner, {
    mutationId: randomUUID(),
    expected: null,
    kind: "enroll",
    grantId,
    scope,
    controller: a.authority.identity,
    directory,
  });
  let destination = new FleetHandoffDestination(
    b.db,
    b.authority,
    b.owner,
    secrets,
  );
  const calls = { commit: 0, receipt: 0 };
  const controls: { fault?: "before" | "after"; wait?: Promise<void> } = {};
  let sent: FleetHandoffProposal | undefined;
  const transport: FleetHandoffTransport = {
    async commit(origin, proposal) {
      calls.commit++;
      sent = proposal;
      expect(origin).toBe(b.origin);
      expect(a.authority.status(a.owner).state).toBe("handoff_pending");
      expect(
        a.db.prepare("SELECT state FROM fleet_handoff_jobs").get(),
      ).toEqual({ state: "uncertain" });
      await controls.wait;
      if (controls.fault === "before") throw new Error("Fixture request loss");
      const result = destination.commit(proposal);
      if (controls.fault === "after") throw new Error("Fixture response loss");
      return result;
    },
    async receipt(origin, query) {
      calls.receipt++;
      expect(origin).toBe(b.origin);
      return destination.receipt(query);
    },
  };
  return {
    a,
    b,
    directory,
    controls,
    calls,
    transport,
    get sent() {
      return sent!;
    },
    get destination() {
      return destination;
    },
    restartDestination() {
      destination = new FleetHandoffDestination(
        b.db,
        new FleetAuthority(b.db, secrets),
        b.owner,
        secrets,
      );
    },
    source: () =>
      new FleetHandoffSource(a.db, a.authority, a.owner, secrets, transport),
    input: {
      operationId: randomUUID(),
      expected: directoryDigest(directory.document),
      destination: b.authority.identity,
    },
  };
}
function storedQuery(f: ReturnType<typeof fixture>): SignedFleetHandoffQuery {
  const row = f.a.db
    .prepare("SELECT directory_digest FROM fleet_handoff_jobs")
    .get() as { directory_digest: string };
  const query = {
    version: 1 as const,
    nonce: randomBytes(32).toString("base64url"),
    operationId: f.input.operationId,
    expected: f.input.expected,
    directory: row.directory_digest,
    controller: f.a.authority.identity,
    destination: f.b.authority.identity,
  };
  return {
    query,
    signature: new FleetProof(f.a.db, f.a.authority.identity, secrets).sign(
      "handoff-query",
      query,
    ),
  };
}

it("rejects an unauthenticated handoff before waiting for a concurrent database writer", () => {
  const f = fixture();
  f.source().begin(f.input);
  const row = f.a.db
    .prepare("SELECT proposal FROM fleet_handoff_jobs")
    .get() as { proposal: string };
  const proposal = JSON.parse(row.proposal) as FleetHandoffProposal;
  const invalid = {
    ...proposal,
    signature: proposal.signature.replace(
      /^./,
      proposal.signature[0] === "A" ? "B" : "A",
    ),
  };
  const writer = new Database(f.b.db.name);
  f.b.db.pragma("busy_timeout=25");
  writer.exec("BEGIN IMMEDIATE");
  try {
    expect(() => f.destination.commit(invalid)).toThrow(/signature/);
  } finally {
    writer.exec("ROLLBACK");
    writer.close();
    f.b.db.pragma("busy_timeout=5000");
  }
  expect(f.b.authority.status(f.b.owner).state).toBe("replica");
});

it("rejects an unauthenticated handoff before opening the destination signing key", () => {
  const f = fixture();
  f.source().begin(f.input);
  let reads = 0;
  const monitored = {
    seal: secrets.seal,
    unseal: (...args: Parameters<typeof secrets.unseal>) => {
      reads++;
      return secrets.unseal(...args);
    },
  };
  const authority = new FleetAuthority(f.b.db, monitored);
  const destination = new FleetHandoffDestination(
    f.b.db,
    authority,
    f.b.owner,
    monitored,
  );
  reads = 0;
  const row = f.a.db
    .prepare("SELECT proposal FROM fleet_handoff_jobs")
    .get() as { proposal: string };
  const proposal = JSON.parse(row.proposal) as FleetHandoffProposal;
  expect(() =>
    destination.commit({
      ...proposal,
      document: { ...proposal.document, mutationId: randomUUID() },
    }),
  ).toThrow(/signature/);
  expect(reads).toBe(0);
  expect(authority.status(f.b.owner).state).toBe("replica");
  destination.commit(proposal);
  expect(reads).toBeGreaterThan(0);
  expect(authority.status(f.b.owner).state).toBe("controller");
});

it.each(["before", "after"] as const)(
  "preserves the single writer after real process death %s destination acceptance",
  async (point) => {
    const f = fixture();
    f.source().begin(f.input);
    // The isolated child exercises durable handoff transactions across process
    // exit. Separate Host fixtures cover the production HTTP admission path.
    const code = `
      import Database from 'better-sqlite3';
      import {FleetAuthority} from './src/server/fleet-authority.ts';
      import {FleetHandoffSource,FleetHandoffDestination} from './src/server/fleet-handoff.ts';
      import * as secrets from './src/server/secrets.ts';
      const a=new Database(${JSON.stringify(f.a.db.name)}), b=new Database(${JSON.stringify(f.b.db.name)});
      const sourceAuthority=new FleetAuthority(a,secrets), destinationAuthority=new FleetAuthority(b,secrets);
      const destination=new FleetHandoffDestination(b,destinationAuthority,${JSON.stringify(f.b.owner)},secrets);
      const source=new FleetHandoffSource(a,sourceAuthority,${JSON.stringify(f.a.owner)},secrets,{
        commit:async (_origin,proposal)=>{
          if (${JSON.stringify(point)}==='before') process.exit(18);
          destination.commit(proposal);
          process.exit(19);
        },
        receipt:async ()=>{throw new Error('Unexpected fixture receipt');},
      });
      await source.advance(${JSON.stringify(f.input.operationId)});
    `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", code],
      {
        env: process.env,
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let errors = "";
    child.stderr.on("data", (chunk) => {
      if (errors.length < 4000) errors += chunk.toString();
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    const exit = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    }).finally(() => clearTimeout(timer));
    expect(exit, errors).toBe(point === "before" ? 18 : 19);
    expect(f.a.authority.status(f.a.owner).state).toBe("handoff_pending");
    expect(f.b.authority.status(f.b.owner).state).toBe(
      point === "before" ? "replica" : "controller",
    );
    const source = f.source();
    expect((await source.advance(f.input.operationId)).state).toBe("uncertain");
    expect(f.calls.commit).toBe(0);
    expect((await source.reconcile(f.input.operationId)).state).toBe(
      point === "before" ? "uncertain" : "complete",
    );
    expect(f.calls.commit).toBe(0);
    expect(f.calls.receipt).toBe(1);
    expect(f.a.authority.status(f.a.owner).state).toBe(
      point === "before" ? "handoff_pending" : "replica",
    );
    expect(
      f.b.db
        .prepare(
          "SELECT count(*) n FROM fleet_handoffs WHERE state='committed'",
        )
        .get(),
    ).toEqual({ n: point === "before" ? 0 : 1 });
  },
  15_000,
);

it("fences and stores the source before dispatch, activates one new writer, and queues authenticated distribution", async () => {
  const f = fixture(),
    source = f.source();
  expect(source.begin(f.input).state).toBe("ready");
  expect(source.begin(f.input).state).toBe("ready");
  expect(f.a.authority.status(f.a.owner).state).toBe("handoff_pending");
  expect(f.b.authority.status(f.b.owner).state).toBe("replica");
  expect(() =>
    f.a.authority.revise(f.a.owner, {
      mutationId: randomUUID(),
      expected: f.input.expected,
      members: f.directory.document.members,
    }),
  ).toThrow("controller");
  const result = await source.advance(f.input.operationId);
  expect(result.state).toBe("complete");
  expect(f.a.authority.status(f.a.owner)).toMatchObject({
    state: "replica",
    head: result.directory,
  });
  expect(f.b.authority.status(f.b.owner)).toMatchObject({
    state: "controller",
    head: result.directory,
  });
  expect(f.a.db.prepare("SELECT state FROM fleet_distribution").all()).toEqual([
    { state: "acked" },
  ]);
  expect(f.b.db.prepare("SELECT state FROM fleet_distribution").all()).toEqual([
    { state: "pending" },
  ]);
  expect(f.a.db.prepare("SELECT state FROM fleet_handoffs").all()).toEqual([
    { state: "committed" },
  ]);
  await source.advance(f.input.operationId);
  await source.reconcile(f.input.operationId);
  expect(f.calls).toEqual({ commit: 1, receipt: 0 });
  expect(JSON.stringify(result)).not.toContain(f.a.owner);
  expect(JSON.stringify(result)).not.toContain(f.b.owner);
  expect(() =>
    new FleetHandoffSource(
      f.a.db,
      f.a.authority,
      "another-owner",
      secrets,
      f.transport,
    ).status(f.input.operationId),
  ).toThrow("not recorded");
  expect(() => source.begin({ ...f.input, expected: "0".repeat(64) })).toThrow(
    "different input",
  );
});

it.each(["before", "after"] as const)(
  "preserves %s dispatch uncertainty through both restarts without replay",
  async (fault) => {
    const f = fixture(),
      source = f.source();
    source.begin(f.input);
    f.controls.fault = fault;
    expect((await source.advance(f.input.operationId)).state).toBe("uncertain");
    f.restartDestination();
    const restarted = f.source();
    await restarted.advance(f.input.operationId);
    f.controls.fault = undefined;
    expect((await restarted.reconcile(f.input.operationId)).state).toBe(
      fault === "after" ? "complete" : "uncertain",
    );
    expect(f.calls).toEqual({ commit: 1, receipt: 1 });
    if (fault === "before") {
      expect(f.a.authority.status(f.a.owner).state).toBe("handoff_pending");
      expect(f.b.authority.status(f.b.owner).state).toBe("replica");
      // The original request arrives late; reconciliation never sends it again.
      f.destination.commit(f.sent);
      expect((await restarted.reconcile(f.input.operationId)).state).toBe(
        "complete",
      );
      expect(f.calls.commit).toBe(1);
    }
    expect(f.a.authority.status(f.a.owner).state).toBe("replica");
    expect(f.b.authority.status(f.b.owner).state).toBe("controller");
  },
);

it("resumes a prepared job after a crash before any dispatch and limits concurrent callers to one claim", async () => {
  const f = fixture();
  f.source().begin(f.input);
  let release!: () => void;
  f.controls.wait = new Promise((resolve) => {
    release = resolve;
  });
  const restarted = f.source();
  const first = restarted.advance(f.input.operationId);
  const others = await Promise.all(
    Array.from({ length: 12 }, () => restarted.advance(f.input.operationId)),
  );
  expect(others.every((value) => value.state === "uncertain")).toBe(true);
  expect(f.calls.commit).toBe(1);
  expect((await restarted.reconcile(f.input.operationId)).state).toBe(
    "uncertain",
  );
  release();
  expect((await first).state).toBe("complete");
  expect(f.calls.commit).toBe(1);
});

it("retires a replaced instance's callback but lets its successor reconcile the same completed effect", async () => {
  const f = fixture(),
    source = f.source();
  source.begin(f.input);
  let release!: () => void;
  f.controls.wait = new Promise((resolve) => {
    release = resolve;
  });
  const first = source.advance(f.input.operationId),
    replacement = f.source();
  release();
  expect((await first).state).toBe("uncertain");
  expect(f.a.authority.status(f.a.owner).state).toBe("handoff_pending");
  expect((await replacement.reconcile(f.input.operationId)).state).toBe(
    "complete",
  );
  expect(f.calls.commit).toBe(1);
});

it("requires the controller's proof and the exact operation, destination and parent for receipt access", async () => {
  const f = fixture(),
    source = f.source();
  source.begin(f.input);
  const query = storedQuery(f);
  expect(f.destination.receipt(query).receipt.state).toBe("missing");
  expect(() =>
    f.destination.receipt({
      ...query,
      query: { ...query.query, nonce: randomBytes(32).toString("base64url") },
    }),
  ).toThrow("not authorized");
  const stranger = machine(),
    strangerProof = new FleetProof(
      stranger.db,
      stranger.authority.identity,
      secrets,
    );
  const forged = { ...query.query, controller: stranger.authority.identity };
  expect(() =>
    f.destination.receipt({
      query: forged,
      signature: strangerProof.sign("handoff-query", forged),
    }),
  ).toThrow("not authorized");
  await source.advance(f.input.operationId);
  const wrong = { ...query.query, operationId: randomUUID() };
  expect(() =>
    f.destination.receipt({
      query: wrong,
      signature: new FleetProof(f.a.db, f.a.authority.identity, secrets).sign(
        "handoff-query",
        wrong,
      ),
    }),
  ).toThrow("not authorized");
  expect(() =>
    new FleetHandoffDestination(
      f.b.db,
      f.b.authority,
      "another-owner",
      secrets,
    ).receipt(query),
  ).toThrow();
});

it("fences an old receipt callback and rejects its replay against a replacement's fresh query", async () => {
  const f = fixture(),
    source = f.source();
  source.begin(f.input);
  f.controls.fault = "after";
  await source.advance(f.input.operationId);
  const receipt = f.transport.receipt;
  let response: unknown, release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.transport.receipt = async (origin, query) => {
    response ??= await receipt(origin, query);
    await gate;
    return response;
  };
  const oldQuery = source.reconcile(f.input.operationId);
  await new Promise((resolve) => setImmediate(resolve));
  const replacement = f.source();
  release();
  expect((await oldQuery).state).toBe("uncertain");
  expect((await replacement.reconcile(f.input.operationId)).state).toBe(
    "uncertain",
  );
  expect(() => source.begin(f.input)).toThrow("replaced");
  f.transport.receipt = receipt;
  expect((await replacement.reconcile(f.input.operationId)).state).toBe(
    "complete",
  );
  expect(f.calls.commit).toBe(1);
});

it("rejects a substituted destination or corrupted proposal before activating authority", async () => {
  const f = fixture(),
    source = f.source(),
    stranger = machine();
  source.begin(f.input);
  const original = f.transport.commit;
  f.transport.commit = async (origin, proposal) =>
    original(origin, {
      ...proposal,
      document: {
        ...proposal.document,
        controller: stranger.authority.identity,
      },
    });
  expect((await source.advance(f.input.operationId)).state).toBe("uncertain");
  expect(f.b.authority.status(f.b.owner).state).toBe("replica");
  expect(f.a.authority.status(f.a.owner).state).toBe("handoff_pending");
});

it("rolls back the source fence when durable job insertion fails and destination activation when outbox storage fails", async () => {
  const f = fixture(),
    source = f.source();
  f.a.db.exec(
    "CREATE TRIGGER fail_handoff_job BEFORE INSERT ON fleet_handoff_jobs BEGIN SELECT RAISE(ABORT,'fixture write failure'); END",
  );
  expect(() => source.begin(f.input)).toThrow("fixture write failure");
  expect(f.a.authority.status(f.a.owner).state).toBe("controller");
  expect(f.a.db.prepare("SELECT count(*) n FROM fleet_handoffs").get()).toEqual(
    { n: 0 },
  );
  f.a.db.exec("DROP TRIGGER fail_handoff_job");
  source.begin(f.input);
  f.b.db.exec(
    "CREATE TRIGGER fail_handoff_outbox BEFORE INSERT ON fleet_distribution BEGIN SELECT RAISE(ABORT,'fixture write failure'); END",
  );
  expect((await source.advance(f.input.operationId)).state).toBe("uncertain");
  expect(f.b.authority.status(f.b.owner).state).toBe("replica");
  expect(f.b.db.prepare("SELECT count(*) n FROM fleet_handoffs").get()).toEqual(
    { n: 0 },
  );
  expect((await source.reconcile(f.input.operationId)).state).toBe("uncertain");
});

it("reconciles at an explicitly confirmed changed origin without rewriting canonical addresses", async () => {
  const f = fixture(),
    source = f.source();
  source.begin(f.input);
  f.controls.fault = "after";
  await source.advance(f.input.operationId);
  f.b.origin = "https://changed-b.example";
  expect((await source.reconcile(f.input.operationId)).state).toBe("uncertain");
  expect((await source.reconcile(f.input.operationId, f.b.origin)).state).toBe(
    "complete",
  );
  expect(
    f.a.authority
      .directory(f.a.owner)!
      .document.members.find(
        (m) => m.machineId === f.b.authority.identity.machineId,
      )!.origin,
  ).not.toBe(f.b.origin);
  expect(f.calls.commit).toBe(1);
});

it("does not dispatch after local authorization is revoked, keeping the prepared writer fence", async () => {
  const f = fixture(),
    source = f.source();
  source.begin(f.input);
  await expect(
    source.advance(f.input.operationId, () => {
      throw new Error("revoked");
    }),
  ).rejects.toThrow("revoked");
  expect(f.calls.commit).toBe(0);
  expect(source.status(f.input.operationId).state).toBe("ready");
  expect(f.a.authority.status(f.a.owner).state).toBe("handoff_pending");
});

it("retains a later explicit recovery when an older uncertain handoff receipt completes", async () => {
  const f = fixture(),
    source = f.source();
  source.begin(f.input);
  f.controls.fault = "after";
  await source.advance(f.input.operationId);
  const recovered = f.a.authority.recover(f.a.owner, {
    mutationId: randomUUID(),
    expected: f.input.expected,
    name: "Recovered A",
    origin: f.a.origin,
    scope,
  });
  expect((await source.reconcile(f.input.operationId)).state).toBe("complete");
  expect(f.a.authority.status(f.a.owner)).toMatchObject({
    state: "controller",
    head: directoryDigest(recovered.document),
  });
  expect(f.a.authority.directory(f.a.owner)!.document.members).toHaveLength(1);
  expect(f.a.db.prepare("SELECT state FROM fleet_handoffs").get()).toEqual({
    state: "committed",
  });
  expect(f.calls.commit).toBe(1);
});
