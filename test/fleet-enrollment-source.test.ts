import { afterAll, expect, it } from "vitest";
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { applyMigrations } from "../src/server/migrations.js";
import { FleetAuthority } from "../src/server/fleet-authority.js";
import { FleetPairing } from "../src/server/fleet-pairing.js";
import { FleetEnrollmentDestination } from "../src/server/fleet-enrollment.js";
import {
  FleetEnrollmentSource,
  type FleetEnrollmentTransport,
} from "../src/server/fleet-enrollment-source.js";
import { directoryDigest, signDirectory } from "../src/server/fleet-crypto.js";
import {
  fleetDeviceFromLink,
  fleetEnrollmentFromLink,
} from "../src/shared/fleet-pairing.js";
import type { StartFleetEnrollment } from "../src/shared/fleet-enrollment-source.js";
import type { FleetOperation } from "../src/shared/fleet.js";

const root = mkdtempSync(join(tmpdir(), "loop-fleet-controller-"));
process.env.LOOP_DATA_DIR = root;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const secrets = await import("../src/server/secrets.js");
const databases: Database.Database[] = [];
const scope: FleetOperation[] = ["read", "act", "events", "mail", "files"];
afterAll(() => {
  for (const db of databases) if (db.open) db.close();
  rmSync(root, { recursive: true, force: true });
});
function machine() {
  const owner = randomUUID(),
    dir = join(root, randomUUID());
  mkdirSync(dir);
  const db = new Database(join(dir, "workspace.db"));
  databases.push(db);
  applyMigrations(db);
  db.prepare("INSERT INTO deployment_profile VALUES(1,'companion')").run();
  const authority = new FleetAuthority(db, secrets);
  let origin = `https://${randomUUID()}.example`;
  const pairing = new FleetPairing(db, authority, owner, dir);
  const destination = new FleetEnrollmentDestination(
    db,
    authority,
    pairing,
    owner,
    secrets,
    () => origin,
  );
  return {
    owner,
    dir,
    db,
    authority,
    pairing,
    destination,
    get origin() {
      return origin;
    },
    setOrigin(value: string) {
      origin = value;
    },
  };
}
function fixture() {
  const a = machine(),
    b = machine(),
    calls = { probe: 0, prepare: 0, commit: 0, receipt: 0 };
  const controls: {
    fault?:
      | "probe"
      | "prepare-before"
      | "prepare-after"
      | "commit-before"
      | "commit-after";
    wait?: Promise<void>;
  } = {};
  const transport: FleetEnrollmentTransport = {
    async probe(origin, input) {
      calls.probe++;
      expect(origin).toBe(b.origin);
      const response = b.destination.probe(input);
      if (controls.fault === "probe")
        response.probe.nonce = randomBytes(32).toString("base64url");
      return response;
    },
    async prepare(origin, input) {
      calls.prepare++;
      expect(origin).toBe(b.origin);
      expect(
        a.db
          .prepare(
            "SELECT state,capability FROM fleet_enrollments WHERE role='source' AND operation_id=?",
          )
          .get(input.intent.operationId),
      ).toEqual({ state: "preparing", capability: null });
      await controls.wait;
      if (controls.fault === "prepare-before")
        throw new Error("Fixture lost request");
      const result = b.destination.prepare(input);
      if (controls.fault === "prepare-after")
        throw new Error("Fixture lost response");
      return result;
    },
    async commit(origin, input) {
      calls.commit++;
      expect(origin).toBe(b.origin);
      expect(
        a.db
          .prepare(
            "SELECT state FROM fleet_enrollments WHERE role='source' AND operation_id=?",
          )
          .get(input.commit.operationId),
      ).toEqual({ state: "uncertain" });
      if (controls.fault === "commit-before")
        throw new Error("Fixture lost request");
      const result = b.destination.commit(input);
      if (controls.fault === "commit-after")
        throw new Error("Fixture lost response");
      return result;
    },
    async receipt(origin, input) {
      calls.receipt++;
      expect(origin).toBe(b.origin);
      return b.destination.receipt(input);
    },
  };
  const creation = {
    mutationId: randomUUID(),
    name: "Same label",
    origin: a.origin,
    scope,
  };
  const directory = a.authority.create(a.owner, creation);
  const source = () =>
    new FleetEnrollmentSource(a.db, a.authority, a.owner, secrets, transport);
  const start = (): { input: StartFleetEnrollment; device: string } => {
    const url = b.pairing.pair(b.origin).url;
    return {
      input: {
        operationId: randomUUID(),
        expected: a.authority.status(a.owner).head!,
        link: fleetEnrollmentFromLink(url),
        name: "Same label",
        mode: "enroll",
        scope,
      },
      device: fleetDeviceFromLink(url, b.origin).secret,
    };
  };
  return {
    a,
    b,
    calls,
    controls,
    transport,
    creation,
    directory,
    source,
    start,
  };
}

it("persists intent before dispatch, confirms both owners without cookies, and records signed completion plus distribution", async () => {
  const f = fixture(),
    source = f.source(),
    { input, device } = f.start();
  expect(source.begin(input).state).toBe("ready");
  expect(source.begin(input)).toEqual(source.status(input.operationId));
  const stored = JSON.stringify(
    f.a.db.prepare("SELECT * FROM fleet_enrollments").all(),
  );
  expect(stored).not.toContain(input.link.enrollment);
  expect(stored).not.toContain(device);
  expect(JSON.stringify(source.list())).not.toContain(input.link.enrollment);
  expect(() => source.begin({ ...input, name: "Different intent" })).toThrow(
    "different input",
  );
  expect((await source.advance(input.operationId)).state).toBe("complete");
  expect(f.calls).toEqual({ probe: 1, prepare: 1, commit: 1, receipt: 0 });
  await source.advance(input.operationId);
  await source.reconcile(input.operationId);
  expect(f.calls.commit).toBe(1);
  expect(f.a.authority.status(f.a.owner).head).toBe(
    f.b.authority.status(f.b.owner).head,
  );
  expect(f.a.owner).not.toBe(f.b.owner);
  expect(f.b.pairing.devices()).toHaveLength(0);
  expect(f.b.db.prepare("SELECT owner_id FROM fleet_binding").get()).toEqual({
    owner_id: f.b.owner,
  });
  expect(f.a.db.prepare("SELECT state FROM fleet_distribution").all()).toEqual([
    { state: "acked" },
  ]);
  expect(
    f.a.db.prepare("SELECT count(*) n FROM fleet_admin_reservations").get(),
  ).toEqual({ n: 0 });
  expect(
    f.b.db.prepare("SELECT count(*) n FROM fleet_local_consents").get(),
  ).toEqual({ n: 1 });
  expect(() => source.cancel(input.operationId)).toThrow("completed");
});

it("proves the exact destination before releasing its capability and rejects device-bearing admin inputs", async () => {
  const f = fixture(),
    source = f.source(),
    { input, device } = f.start();
  expect(() =>
    source.begin({ ...input, link: { ...input.link, device } } as never),
  ).toThrow();
  source.begin(input);
  f.controls.fault = "probe";
  await expect(source.advance(input.operationId)).rejects.toThrow(
    "could not prove",
  );
  expect(source.status(input.operationId).state).toBe("ready");
  expect(f.calls.prepare).toBe(0);
  expect(
    f.b.db
      .prepare("SELECT state FROM pairing_ceremonies WHERE id=?")
      .get(input.link.ceremonyId),
  ).toEqual({ state: "pending" });
  f.controls.fault = undefined;
  expect((await source.advance(input.operationId)).state).toBe("complete");
});

it("reserves directory administration across tabs and refuses a conflicting relayed successor", () => {
  const f = fixture(),
    source = f.source(),
    { input } = f.start();
  source.begin(input);
  const revision = {
    mutationId: input.operationId,
    expected: input.expected,
    members: f.directory.document.members,
  };
  expect(() => f.a.authority.revise(f.a.owner, revision)).toThrow(
    "pending enrollment",
  );
  expect(() =>
    f.a.authority.recover(f.a.owner, {
      ...f.creation,
      mutationId: randomUUID(),
      expected: input.expected,
    }),
  ).toThrow("pending enrollment");
  expect(() =>
    f.a.authority.prepareHandoff(f.a.owner, {
      mutationId: randomUUID(),
      expected: input.expected,
      destination: f.b.authority.identity,
    }),
  ).toThrow("pending enrollment");
  const document = {
    ...f.directory.document,
    revision: 1,
    kind: "revision" as const,
    parent: input.expected,
    mutationId: randomUUID(),
  };
  const key = f.a.db
    .prepare("SELECT private_key FROM fleet_machine_identity")
    .get() as { private_key: string };
  const signed = {
    document,
    signature: signDirectory(
      document,
      secrets.unseal(
        key.private_key,
        `fleet:machine:${f.a.authority.identity.machineId}`,
      ),
    ),
    acceptance: null,
  };
  expect(() => f.a.authority.accept(f.a.owner, signed)).toThrow(
    "pending enrollment",
  );
  expect(f.a.authority.create(f.a.owner, f.creation)).toEqual(f.directory);
  expect(() => source.begin(f.start().input)).toThrow("pending enrollment");
  source.cancel(input.operationId);
  expect(source.status(input.operationId).state).toBe("cancelled");
  expect(f.a.authority.revise(f.a.owner, revision).document.revision).toBe(1);
});

it.each(["prepare-before", "prepare-after"] as const)(
  "retains %s uncertainty through restart and never resubmits preparation",
  async (fault) => {
    const f = fixture(),
      source = f.source(),
      { input } = f.start();
    source.begin(input);
    f.controls.fault = fault;
    expect((await source.advance(input.operationId)).state).toBe("uncertain");
    const restarted = f.source();
    await restarted.advance(input.operationId);
    f.controls.fault = undefined;
    const result = await restarted.reconcile(input.operationId);
    expect(f.calls.prepare).toBe(1);
    if (fault === "prepare-after") {
      expect(result.state).toBe("prepared");
      expect((await restarted.advance(input.operationId)).state).toBe(
        "complete",
      );
      expect(f.calls.prepare).toBe(1);
      expect(f.calls.commit).toBe(1);
    } else {
      expect(result.state).toBe("uncertain");
      expect(f.calls.commit).toBe(0);
      expect(restarted.cancel(input.operationId).state).toBe("cancelled");
    }
  },
);

it.each(["commit-before", "commit-after"] as const)(
  "keeps the exact published directory and reconciles %s without another commit",
  async (fault) => {
    const f = fixture(),
      source = f.source(),
      { input } = f.start();
    source.begin(input);
    f.controls.fault = fault;
    const result = await source.advance(input.operationId);
    expect(result).toMatchObject({ state: "uncertain", phase: "commit" });
    expect(result.directory).toBe(f.a.authority.status(f.a.owner).head);
    expect(() => source.cancel(input.operationId)).toThrow("Reconcile");
    const restarted = f.source();
    f.controls.fault = undefined;
    await restarted.advance(input.operationId);
    const receipt = await restarted.reconcile(input.operationId);
    expect(f.calls.commit).toBe(1);
    if (fault === "commit-after") {
      expect(receipt.state).toBe("complete");
      expect(
        f.b.db.prepare("SELECT count(*) n FROM fleet_local_consents").get(),
      ).toEqual({ n: 1 });
    } else {
      expect(receipt).toMatchObject({
        state: "uncertain",
        remoteState: "prepared",
      });
      await restarted.advance(input.operationId);
      expect(f.calls.commit).toBe(1);
      f.b.destination.cancel(input.operationId);
      expect((await restarted.reconcile(input.operationId)).state).toBe(
        "cancelled",
      );
      const resumed = f.start().input;
      restarted.begin(resumed);
      expect((await restarted.advance(resumed.operationId)).state).toBe(
        "complete",
      );
      expect(
        f.a.authority
          .directory(f.a.owner)!
          .document.members.find(
            (m) => m.machineId === f.b.authority.identity.machineId,
          )?.grantId,
      ).toBe(
        f.b.authority
          .directory(f.b.owner)!
          .document.members.find(
            (m) => m.machineId === f.b.authority.identity.machineId,
          )?.grantId,
      );
    }
  },
);

it.each(["receipt-first", "commit-first"] as const)(
  "retains successful commit proof during concurrent prepared reconciliation (%s)",
  async (order) => {
    const f = fixture(),
      source = f.source(),
      { input } = f.start(),
      commit = f.transport.commit,
      receipt = f.transport.receipt;
    let releaseCommit!: () => void, releaseReceipt!: () => void;
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const receiptGate = new Promise<void>((resolve) => {
      releaseReceipt = resolve;
    });
    f.transport.commit = async (origin, request) => {
      await commitGate;
      return commit(origin, request);
    };
    f.transport.receipt = async (origin, request) => {
      const prepared = await receipt(origin, request);
      await receiptGate;
      return prepared;
    };
    source.begin(input);
    const advancing = source.advance(input.operationId);
    await new Promise((resolve) => setImmediate(resolve));
    expect(source.status(input.operationId)).toMatchObject({
      state: "uncertain",
      phase: "commit",
    });
    const reconciling = source.reconcile(input.operationId);
    await new Promise((resolve) => setImmediate(resolve));
    if (order === "receipt-first") {
      releaseReceipt();
      expect((await reconciling).state).toBe("uncertain");
      releaseCommit();
    } else {
      releaseCommit();
      expect((await advancing).state).toBe("complete");
      releaseReceipt();
    }
    await Promise.all([advancing, reconciling]);
    expect(source.status(input.operationId)).toMatchObject({
      state: "complete",
      remoteState: "complete",
    });
    expect(
      f.a.db
        .prepare(
          "SELECT state,attempt_id FROM fleet_enrollments WHERE role='source' AND operation_id=?",
        )
        .get(input.operationId),
    ).toEqual({ state: "complete", attempt_id: null });
    expect(
      f.a.db
        .prepare("SELECT state FROM fleet_distribution WHERE peer_id=?")
        .get(f.b.authority.identity.machineId),
    ).toEqual({ state: "acked" });
    await source.advance(input.operationId);
    expect(f.calls).toEqual({ probe: 1, prepare: 1, commit: 1, receipt: 1 });
    expect(
      f.b.db.prepare("SELECT count(*) n FROM fleet_local_consents").get(),
    ).toEqual({ n: 1 });
  },
);

it("fences an old identity probe across a replacement using another database connection", async () => {
  const f = fixture(),
    source = f.source(),
    { input } = f.start(),
    probe = f.transport.probe;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.transport.probe = async (origin, request) => {
    const result = await probe(origin, request);
    await gate;
    return result;
  };
  source.begin(input);
  const first = source.advance(input.operationId);
  await new Promise((resolve) => setImmediate(resolve));
  const connection = new Database(join(f.a.dir, "workspace.db"));
  databases.push(connection);
  const replacement = new FleetEnrollmentSource(
    connection,
    new FleetAuthority(connection, secrets),
    f.a.owner,
    secrets,
    f.transport,
  );
  release();
  expect((await first).state).toBe("ready");
  expect(f.calls.prepare).toBe(0);
  expect(f.calls.commit).toBe(0);
  expect(f.a.authority.status(f.a.owner).head).toBe(input.expected);
  expect(
    f.b.db
      .prepare("SELECT state FROM pairing_ceremonies WHERE id=?")
      .get(input.link.ceremonyId),
  ).toEqual({ state: "pending" });
  expect(() => source.cancel(input.operationId)).toThrow("replaced");
  expect((await replacement.advance(input.operationId)).state).toBe("complete");
  expect(f.calls.prepare).toBe(1);
  expect(f.calls.commit).toBe(1);
});

it("fences late callbacks from a replaced source instance and only advances from its authenticated receipt", async () => {
  const f = fixture(),
    source = f.source(),
    { input } = f.start();
  let release!: () => void;
  f.controls.wait = new Promise((resolve) => {
    release = resolve;
  });
  source.begin(input);
  const first = source.advance(input.operationId);
  await new Promise((resolve) => setImmediate(resolve));
  expect(f.calls.prepare).toBe(1);
  const replacement = f.source();
  release();
  expect((await first).state).toBe("uncertain");
  expect(f.calls.commit).toBe(0);
  expect((await replacement.reconcile(input.operationId)).state).toBe(
    "prepared",
  );
  expect((await replacement.advance(input.operationId)).state).toBe("complete");
  expect(f.calls.prepare).toBe(1);
  expect(f.calls.commit).toBe(1);
});

it("does not let an old prepare callback publish after its replacement has reconciled the receipt", async () => {
  const f = fixture(),
    source = f.source(),
    { input } = f.start();
  const prepare = f.transport.prepare;
  let released!: () => void, prepared!: () => void;
  const release = new Promise<void>((resolve) => {
    released = resolve;
  });
  const accepted = new Promise<void>((resolve) => {
    prepared = resolve;
  });
  f.transport.prepare = async (origin, request) => {
    const proof = await prepare(origin, request);
    prepared();
    await release;
    return proof;
  };
  source.begin(input);
  const old = source.advance(input.operationId);
  await accepted;
  const replacement = f.source();
  expect((await replacement.reconcile(input.operationId)).state).toBe(
    "prepared",
  );
  released();
  expect((await old).state).toBe("prepared");
  expect(f.calls.commit).toBe(0);
  expect(f.a.authority.status(f.a.owner).head).toBe(input.expected);
  expect((await replacement.advance(input.operationId)).state).toBe("complete");
  expect(f.calls.prepare).toBe(1);
  expect(f.calls.commit).toBe(1);
});

it("gives concurrent advance callers one durable dispatch and isolates another local owner", async () => {
  const f = fixture(),
    source = f.source(),
    { input } = f.start();
  source.begin(input);
  const other = new FleetEnrollmentSource(
    f.a.db,
    f.a.authority,
    "another-owner",
    secrets,
    f.transport,
  );
  expect(() => other.status(input.operationId)).toThrow("not recorded");
  expect(() => other.begin({ ...input, operationId: randomUUID() })).toThrow(
    "no fleet grant",
  );
  await Promise.all([
    source.advance(input.operationId),
    source.advance(input.operationId),
  ]);
  expect(source.status(input.operationId).state).toBe("complete");
  expect(f.calls.prepare).toBe(1);
  expect(f.calls.commit).toBe(1);
});

it("reconciles a real controller process death after destination acceptance without dispatching again", async () => {
  const f = fixture(),
    source = f.source(),
    { input } = f.start();
  source.begin(input);
  // This isolated loopback adapter exercises process death around the actual
  // durable job/consent boundary. It is not production peer admission coverage.
  const server = createServer(async (req, res) => {
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
        if (Buffer.byteLength(body) > 1_000_000)
          throw new Error("Fixture body too large");
      }
      const { origin, payload } = JSON.parse(body);
      const operation = req.url?.slice(1) as keyof FleetEnrollmentTransport;
      if (!["probe", "prepare", "commit", "receipt"].includes(operation))
        throw new Error("Unknown fixture path");
      const response = await f.transport[operation](origin, payload);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(response));
    } catch {
      res.writeHead(500).end('{"error":"Fixture refused"}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture listener missing");
  const url = `http://127.0.0.1:${address.port}`;
  const code = `
    import Database from 'better-sqlite3';
    import {FleetAuthority} from './src/server/fleet-authority.ts';
    import {FleetEnrollmentSource} from './src/server/fleet-enrollment-source.ts';
    import * as secrets from './src/server/secrets.ts';
    const db=new Database(${JSON.stringify(join(f.a.dir, "workspace.db"))});
    const authority=new FleetAuthority(db,secrets);
    const call=async (operation,origin,payload)=>{
      const response=await fetch(${JSON.stringify(url)}+'/'+operation,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({origin,payload})});
      if(!response.ok) throw new Error('Fixture request refused');
      return await response.json();
    };
    const transport={
      probe:(origin,input)=>call('probe',origin,input),
      prepare:(origin,input)=>call('prepare',origin,input),
      receipt:(origin,input)=>call('receipt',origin,input),
      commit:async(origin,input)=>{await call('commit',origin,input);process.exit(17);},
    };
    const source=new FleetEnrollmentSource(db,authority,${JSON.stringify(f.a.owner)},secrets,transport);
    await source.advance(${JSON.stringify(input.operationId)});
  `;
  try {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", code],
      { env: process.env, stdio: ["ignore", "ignore", "pipe"] },
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
    expect(exit, errors).toBe(17);
    expect(f.calls.prepare).toBe(1);
    expect(f.calls.commit).toBe(1);
    expect(
      f.b.db.prepare("SELECT count(*) n FROM fleet_local_consents").get(),
    ).toEqual({ n: 1 });
    const restarted = f.source();
    expect(restarted.status(input.operationId)).toMatchObject({
      state: "uncertain",
      phase: "commit",
    });
    expect((await restarted.reconcile(input.operationId)).state).toBe(
      "complete",
    );
    await restarted.advance(input.operationId);
    expect(f.calls.commit).toBe(1);
    expect(
      f.a.db.prepare("SELECT count(*) n FROM fleet_admin_reservations").get(),
    ).toEqual({ n: 0 });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 20_000);

it("rolls back publication and its reservation pin on local storage failure before any commit dispatch", async () => {
  const f = fixture(),
    source = f.source(),
    { input } = f.start();
  source.begin(input);
  f.a.db.exec(
    "CREATE TRIGGER fixture_publication_failure BEFORE INSERT ON fleet_distribution BEGIN SELECT RAISE(ABORT,'fixture publication failure'); END",
  );
  await expect(source.advance(input.operationId)).rejects.toThrow(
    "fixture publication failure",
  );
  expect(source.status(input.operationId)).toMatchObject({
    state: "prepared",
    directory: null,
  });
  expect(f.a.authority.status(f.a.owner).head).toBe(input.expected);
  expect(
    f.a.db
      .prepare("SELECT revision_digest FROM fleet_admin_reservations")
      .get(),
  ).toEqual({ revision_digest: null });
  expect(f.calls.commit).toBe(0);
  f.a.db.exec("DROP TRIGGER fixture_publication_failure");
  expect((await source.advance(input.operationId)).state).toBe("complete");
  expect(f.calls.prepare).toBe(1);
  expect(f.calls.commit).toBe(1);
});

it("allows canonical removal during an uncertain enrollment without treating uncertainty as a cancelled remote effect", async () => {
  const f = fixture(),
    source = f.source(),
    { input } = f.start();
  source.begin(input);
  f.controls.fault = "commit-before";
  const uncertain = await source.advance(input.operationId);
  expect(uncertain.state).toBe("uncertain");
  const current = f.a.authority.directory(f.a.owner)!;
  const removal = f.a.authority.revise(f.a.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(current.document),
    members: current.document.members.filter(
      (m) => m.machineId !== f.b.authority.identity.machineId,
    ),
  });
  expect(removal.document.tombstones).toContain(
    f.b.authority.identity.machineId,
  );
  expect((await source.reconcile(input.operationId)).state).toBe("uncertain");
  await source.advance(input.operationId);
  expect(f.calls.commit).toBe(1);
  expect(source.status(input.operationId).directory).toBe(uncertain.directory);
});

it("does not dispatch a published enrollment removed before the first commit attempt", async () => {
  const f = fixture(),
    source = f.source(),
    { input } = f.start();
  source.begin(input);
  f.a.db.exec(
    "CREATE TRIGGER fixture_before_commit BEFORE UPDATE OF state ON fleet_enrollments WHEN OLD.role='source' AND OLD.state='published' AND NEW.state='uncertain' BEGIN SELECT RAISE(ABORT,'fixture dispatch persistence failure'); END",
  );
  await expect(source.advance(input.operationId)).rejects.toThrow(
    "fixture dispatch persistence failure",
  );
  expect(source.status(input.operationId).state).toBe("published");
  const published = f.a.authority.directory(f.a.owner)!;
  f.a.authority.revise(f.a.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(published.document),
    members: published.document.members.filter(
      (m) => m.machineId !== f.b.authority.identity.machineId,
    ),
  });
  f.a.db.exec("DROP TRIGGER fixture_before_commit");
  expect((await f.source().advance(input.operationId)).state).toBe("cancelled");
  expect(f.calls.commit).toBe(0);
  expect(
    f.b.db.prepare("SELECT count(*) n FROM fleet_local_consents").get(),
  ).toEqual({ n: 0 });
});

it("does not release a newer operation's reservation when an older receipt completes", async () => {
  const f = fixture(),
    source = f.source(),
    { input } = f.start();
  source.begin(input);
  f.controls.fault = "commit-after";
  expect((await source.advance(input.operationId)).state).toBe("uncertain");
  const next = { ...f.start().input, mode: "repair" as const };
  source.begin(next);
  expect((await source.reconcile(input.operationId)).state).toBe("complete");
  expect(
    f.a.db.prepare("SELECT operation_id FROM fleet_admin_reservations").get(),
  ).toEqual({ operation_id: next.operationId });
  source.cancel(next.operationId);
});

it("reconciles an older uncertain enrollment at the destination's repaired origin without repeating either commit", async () => {
  const f = fixture(),
    source = f.source(),
    { input } = f.start();
  source.begin(input);
  f.controls.fault = "commit-after";
  expect((await source.advance(input.operationId)).state).toBe("uncertain");
  const original = f.a.db
    .prepare(
      "SELECT committed FROM fleet_enrollments WHERE owner_id=? AND role='source' AND operation_id=?",
    )
    .get(f.a.owner, input.operationId);
  f.b.setOrigin(`https://${randomUUID()}.example`);
  f.controls.fault = undefined;
  const repair = { ...f.start().input, mode: "repair" as const };
  source.begin(repair);
  expect((await source.advance(repair.operationId)).state).toBe("complete");
  expect((await source.reconcile(input.operationId)).state).toBe("complete");
  expect(f.calls.commit).toBe(2);
  expect(f.calls.prepare).toBe(2);
  expect(
    f.a.db
      .prepare(
        "SELECT committed FROM fleet_enrollments WHERE owner_id=? AND role='source' AND operation_id=?",
      )
      .get(f.a.owner, input.operationId),
  ).toEqual(original);
  expect(
    f.a.authority
      .directory(f.a.owner)!
      .document.members.find(
        (m) => m.machineId === f.b.authority.identity.machineId,
      )?.origin,
  ).toBe(f.b.origin);
});
