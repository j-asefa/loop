import { createHost } from "./helpers/gateway.js";
import { afterAll, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { Headers, Response, type fetch as PeerFetch } from "undici";
import { applyMigrations } from "../src/server/migrations.js";
import { FleetAuthority } from "../src/server/fleet-authority.js";
import { FleetCredentials } from "../src/server/fleet-credentials.js";
import { FleetCredentialLeases } from "../src/server/fleet-credential-leases.js";
import { FleetCredentialHttpTransport } from "../src/server/fleet-credential-http.js";
import { FleetPairing } from "../src/server/fleet-pairing.js";
import { FleetEnrollmentDestination } from "../src/server/fleet-enrollment.js";
import { FleetMailDestination } from "../src/server/fleet-mail-destination.js";
import { FleetMailHttpTransport } from "../src/server/fleet-mail-http.js";
import { FleetMailJournal } from "../src/server/fleet-mail-journal.js";
import { FleetPeerMail } from "../src/server/fleet-peer-mail.js";
import { FleetCapacity } from "../src/server/fleet-capacity.js";
import { FleetProof } from "../src/server/fleet-proof.js";
import {
  directoryDigest,
  fleetPayloadDigest,
} from "../src/server/fleet-crypto.js";
import {
  FleetMailEnvelope,
  FLEET_MAIL_PEER_PENDING,
  FLEET_MAIL_PREPARE_MS,
} from "../src/shared/fleet-mail.js";
import { fleetMailApi } from "../src/shared/fleet-mail-api.js";
import { FLEET_MAIL_FILE_CHUNK_BYTES } from "../src/shared/fleet-mail-files.js";
import { fleetPeerApi } from "../src/shared/fleet-peer-api.js";
import type { FleetOperation } from "../src/shared/fleet.js";
import { secret } from "../src/state.js";

const root = mkdtempSync(join(tmpdir(), "loop-fleet-mail-http-"));
process.env.LOOP_DATA_DIR = root;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const secrets = await import("../src/server/secrets.js");
const { createFleetPeerHttp } =
  await import("../src/server/fleet-peer-http.js");
const { db: globalDb } = await import("../src/server/db.js");
const seed = new Database(":memory:");
applyMigrations(seed);
const schema = seed.serialize();
seed.close();
afterAll(() => {
  if (globalDb.open) globalDb.close();
  rmSync(root, { recursive: true, force: true });
});
function machine() {
  const dir = join(root, randomUUID());
  mkdirSync(dir);
  writeFileSync(join(dir, "db.sqlite"), schema);
  const db = new Database(join(dir, "db.sqlite"));
  db.pragma("foreign_keys=ON");
  db.exec(
    "CREATE TABLE fixture_mail_queue(id TEXT PRIMARY KEY, body TEXT NOT NULL)",
  );
  db.exec(
    "CREATE TABLE fixture_file_copies(id TEXT PRIMARY KEY, bytes BLOB NOT NULL)",
  );
  const authority = new FleetAuthority(db, secrets),
    owner = randomUUID();
  return {
    dir,
    db,
    owner,
    authority,
    credentials: new FleetCredentials(db, authority, secrets),
    journal: new FleetMailJournal(db, authority, owner),
  };
}
async function fixture(scopes: FleetOperation[] = ["read", "mail", "files"]) {
  const a = machine(),
    b = machine(),
    recipient = randomUUID();
  let origin = "https://destination.example";
  const first = a.authority.create(a.owner, {
    mutationId: randomUUID(),
    name: "Same name",
    origin: "https://source.example",
    scope: scopes,
  });
  let directory = a.authority.revise(a.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(first.document),
    members: [
      ...first.document.members,
      {
        ...b.authority.identity,
        grantId: randomUUID(),
        name: "Same name",
        origin,
      },
    ],
  });
  b.authority.approve(b.owner, {
    mutationId: randomUUID(),
    expected: null,
    kind: "enroll",
    grantId: directory.document.members[1].grantId,
    scope: scopes,
    controller: a.authority.identity,
    directory,
  });
  let deliveryStatus: "queued" | "handled" = "queued";
  let failAdmission = false;
  let destinationTime = Date.now();
  const service = new FleetMailDestination(
    b.db,
    b.authority,
    b.credentials,
    b.owner,
    secrets,
    {
      directory: () => ({
        agents: [
          {
            agentId: recipient,
            name: "Remote agent",
            runtime: "Pi",
            availability: "available",
          },
        ],
        nextOffset: null,
      }),
      admit: (envelope, copyFiles) => {
        expect(envelope.destination.agentId).toBe(recipient);
        if (envelope.files.length)
          copyFiles!((file, bytes) => {
            b.db
              .prepare("INSERT INTO fixture_file_copies VALUES(?,?)")
              .run(file.fileId, bytes);
            return file.fileId;
          });
        const id = randomUUID();
        b.db
          .prepare("INSERT INTO fixture_mail_queue VALUES(?,?)")
          .run(id, envelope.body);
        if (failAdmission) throw new Error("fixture admission rollback");
        return {
          state: "accepted",
          mailId: id,
          threadId: randomUUID(),
          conversationId: randomUUID(),
          status: "queued",
        };
      },
      inspect: (admission) =>
        admission.state === "accepted"
          ? { ...admission, status: deliveryStatus }
          : admission,
    },
    () => destinationTime,
  );
  const pairing = new FleetPairing(b.db, b.authority, b.owner, b.dir);
  const enrollment = new FleetEnrollmentDestination(
    b.db,
    b.authority,
    pairing,
    b.owner,
    secrets,
    () => origin,
  );
  const host = createHost(b.dir, pairing);
  let workspaceCalls = 0;
  const inboundCapacity = new FleetCapacity(() => true);
  host.workspace = {
    fleetCapacity: inboundCapacity,
    http: (_req, res) => {
      workspaceCalls++;
      res.writeHead(404).end();
    },
    peerHttp: createFleetPeerHttp(enrollment, () => origin, {
      credentials: b.credentials,
      mail: service,
    }),
    status: () => ({}),
    admin: async () => ({}),
    connect: () => () => {},
    originChanged: () => {},
  };
  await host.listen();
  host.setOrigin(origin);
  function call(
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
    signal?: AbortSignal,
  ) {
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port: host.port,
          path,
          method: "POST",
          signal,
          headers: {
            host: new URL(origin).host,
            "content-type": "application/json",
            "x-loop-fleet-version": "1",
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () =>
            resolve({
              status: res.statusCode!,
              body: JSON.parse(Buffer.concat(chunks).toString()),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });
  }
  let mode:
    | "normal"
    | "offline"
    | "lost"
    | "missing"
    | "tampered"
    | "replayed"
    | "before-accept"
    | "destination-busy"
    | "lost-prepare"
    | "tampered-prepare"
    | "lost-file"
    | "tampered-file"
    | "wrong-key" = "normal";
  let lastDirectory: unknown;
  let hold: Promise<void> | undefined;
  let onDirectory: (() => void) | undefined;
  const calls: string[] = [];
  const sentEnvelopes: FleetMailEnvelope[] = [];
  const sentReservations: string[] = [];
  const fileOffsets: number[] = [];
  const destinationProof = new FleetProof(b.db, b.authority.identity, secrets);
  const sourceProof = new FleetProof(a.db, a.authority.identity, secrets);
  const fetcher: typeof PeerFetch = async (url, options) => {
    const target = new URL(String(url));
    expect(target.origin).toBe(origin);
    const headers = new Headers(options?.headers);
    for (const name of ["cookie", "authorization", "origin", "x-loop-csrf"])
      expect(headers.has(name)).toBe(false);
    calls.push(target.pathname);
    if (mode === "offline") throw new Error("fixture offline");
    const input = JSON.parse(String(options?.body));
    const held: (() => void)[] = [];
    if (target.pathname === "/api" + fleetMailApi.accept.path) {
      expect(a.journal.outgoing(input.envelope.messageId)?.state).toBe(
        "unknown",
      );
      sentEnvelopes.push(structuredClone(input.envelope));
      sentReservations.push(input.reservationId);
      if (mode === "before-accept")
        throw new Error("fixture lost request before admission");
      if (mode === "destination-busy")
        for (let i = 0; i < 64; i++)
          held.push(inboundCapacity.acquire("peer")!);
    }
    let reply: Awaited<ReturnType<typeof call>>;
    try {
      reply = await call(
        target.pathname,
        input,
        {},
        options?.signal ?? undefined,
      );
    } finally {
      for (const release of held) release();
    }
    let body = reply.body;
    if (target.pathname === "/api" + fleetMailApi.file.path) {
      fileOffsets.push(input.offset);
      if (mode === "lost-file")
        throw new Error("fixture lost file acknowledgement");
      if (mode === "tampered-file") body.response.nextOffset = null;
    }
    if (target.pathname === "/api" + fleetMailApi.prepare.path) {
      if (mode === "lost-prepare")
        throw new Error("fixture lost preparation reply");
      if (mode === "tampered-prepare")
        body.response.receipt.admission.reservationId = randomUUID();
    }
    if (
      target.pathname === "/api" + fleetPeerApi.enrollmentProbe.path &&
      mode === "wrong-key"
    )
      body.signature = sourceProof.sign("enrollment-probe", body.probe);
    if (target.pathname === "/api" + fleetMailApi.directory.path) {
      onDirectory?.();
      if (hold) await hold;
      if (mode === "tampered") body.response.page.agents[0].name = "Forged";
      else if (mode === "replayed") body = lastDirectory;
      else lastDirectory = structuredClone(body);
    }
    if (
      target.pathname === "/api" + fleetMailApi.accept.path &&
      mode === "lost"
    )
      throw new Error("fixture lost acceptance reply");
    if (
      target.pathname === "/api" + fleetMailApi.receipt.path &&
      mode === "missing"
    ) {
      body.response.receipt = null;
      body.signature = destinationProof.sign("mail-delivery", body.response);
    }
    return new Response(JSON.stringify(body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  };
  const capacity = new FleetCapacity(() => true);
  const leases = new FleetCredentialLeases(
    a.authority,
    a.credentials,
    a.owner,
    new FleetCredentialHttpTransport(fetcher, capacity),
  );
  const transport = new FleetMailHttpTransport(fetcher, capacity);
  let client = new FleetPeerMail(
    a.authority,
    leases,
    a.owner,
    a.journal,
    transport,
  );
  function envelope() {
    return FleetMailEnvelope.parse({
      version: 1,
      messageId: randomUUID(),
      source: {
        machineId: a.authority.identity.machineId,
        agentId: randomUUID(),
      },
      destination: {
        machineId: b.authority.identity.machineId,
        agentId: recipient,
      },
      authority: {
        fleetId: directory.document.fleetId,
        directory: directoryDigest(directory.document),
        sourceGrantId: directory.document.members[0].grantId,
        destinationGrantId: directory.document.members[1].grantId,
      },
      sender: {
        name: "Source agent",
        runId: randomUUID(),
        conversationId: randomUUID(),
      },
      thread: {
        origin: a.authority.identity.machineId,
        id: randomUUID(),
        subject: "Fixture direct mail",
        recipientConversationId: null,
      },
      body: "Fixture context only; no provider calls",
      interrupt: false,
      files: [],
    });
  }
  return {
    a,
    b,
    host,
    service,
    leases,
    transport,
    capacity,
    calls,
    sentEnvelopes,
    sentReservations,
    fileOffsets,
    envelope,
    call,
    recipient,
    get client() {
      return client;
    },
    get origin() {
      return origin;
    },
    get workspaceCalls() {
      return workspaceCalls;
    },
    mode(value: typeof mode) {
      mode = value;
    },
    complete() {
      deliveryStatus = "handled";
    },
    failAdmission(value = true) {
      failAdmission = value;
    },
    expireReservation() {
      destinationTime += FLEET_MAIL_PREPARE_MS;
    },
    blockDirectory(gate: Promise<void>, began: () => void) {
      hold = gate;
      onDirectory = began;
    },
    restartClient() {
      client.close();
      client = new FleetPeerMail(
        a.authority,
        leases,
        a.owner,
        new FleetMailJournal(a.db, a.authority, a.owner),
        transport,
      );
    },
    async repair() {
      origin = "https://repaired.example";
      directory = a.authority.revise(a.owner, {
        mutationId: randomUUID(),
        expected: directoryDigest(directory.document),
        members: directory.document.members.map((m) =>
          m.machineId === b.authority.identity.machineId ? { ...m, origin } : m,
        ),
      });
      b.authority.accept(b.owner, directory);
      host.setOrigin(origin);
      await Promise.resolve();
    },
    disable() {
      host.workspace!.peerHttp = createFleetPeerHttp(enrollment, () => origin, {
        credentials: b.credentials,
      });
    },
    async token(operation: FleetOperation) {
      return (await leases.get(b.authority.identity.machineId, operation))
        .token;
    },
    async close() {
      client.close();
      leases.close();
      service.close();
      await host.close();
      a.db.close();
      b.db.close();
    },
  };
}
const allowed = () => {};
const accepts = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.calls.filter((path) => path === "/api" + fleetMailApi.accept.path).length;

it("queries the actual peer HTTP directory and rejects tampered or replayed signed responses", async () => {
  const f = await fixture();
  try {
    const page = await f.client.directory(
      f.b.authority.identity.machineId,
      {},
      allowed,
    );
    expect(page.agents).toEqual([
      {
        agentId: f.recipient,
        name: "Remote agent",
        runtime: "Pi",
        availability: "available",
      },
    ]);
    for (const mode of ["tampered", "replayed"] as const) {
      f.mode(mode);
      await expect(
        f.client.directory(f.b.authority.identity.machineId, {}, allowed),
      ).rejects.toMatchObject({ status: 502 });
    }
    expect(f.workspaceCalls).toBe(0);
  } finally {
    await f.close();
  }
});

it("persists uncertainty before IO and reconciles a lost acceptance after client restart without another send", async () => {
  const f = await fixture();
  try {
    const value = f.envelope();
    f.a.journal.enqueue(value, allowed);
    f.mode("lost");
    await expect(
      f.client.deliver(value.messageId, allowed),
    ).rejects.toMatchObject({ status: 502 });
    expect(f.a.journal.outgoing(value.messageId)?.state).toBe("unknown");
    expect(
      f.b.db.prepare("SELECT count(*) n FROM fixture_mail_queue").get(),
    ).toEqual({ n: 1 });
    f.restartClient();
    f.mode("missing");
    expect(
      (await f.client.deliver(value.messageId, allowed)).receiptAvailable,
    ).toBe(false);
    expect(f.a.journal.outgoing(value.messageId)?.state).toBe("unknown");
    f.mode("normal");
    expect(
      (await f.client.deliver(value.messageId, allowed)).delivery.receipt
        ?.admission,
    ).toMatchObject({ state: "accepted", status: "queued" });
    f.complete();
    expect(
      (await f.client.deliver(value.messageId, allowed)).delivery,
    ).toMatchObject({
      settled: true,
      receipt: { admission: { status: "handled" } },
    });
    expect(accepts(f)).toBe(1);
    expect(
      f.b.db.prepare("SELECT count(*) n FROM fixture_mail_queue").get(),
    ).toEqual({ n: 1 });
  } finally {
    await f.close();
  }
});

function attach(value: FleetMailEnvelope, bytes: Buffer) {
  value.files = [
    {
      source: value.source.machineId,
      fileId: randomUUID(),
      digest: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      name: "shared.bin",
      mediaType: "application/octet-stream",
    },
  ];
  return value;
}

it("resumes private file chunks and reconciles lost mail acceptance without another copy or prompt", async () => {
  const f = await fixture();
  try {
    const bytes = randomBytes(FLEET_MAIL_FILE_CHUNK_BYTES + 31);
    const value = attach(f.envelope(), bytes);
    f.a.journal.enqueue(value, allowed);
    const read = (envelope: FleetMailEnvelope, fileId: string) => {
      expect(envelope).toEqual(value);
      expect(fileId).toBe(value.files[0].fileId);
      return bytes;
    };
    f.mode("lost-file");
    await expect(
      f.client.deliver(value.messageId, allowed, undefined, read),
    ).rejects.toThrow();
    expect(f.a.journal.outgoing(value.messageId)?.state).toBe("pending");
    expect(
      f.b.db.prepare("SELECT count(*) n FROM fixture_file_copies").get(),
    ).toEqual({ n: 0 });
    expect(accepts(f)).toBe(0);
    f.mode("lost");
    await expect(
      f.client.deliver(value.messageId, allowed, undefined, read),
    ).rejects.toThrow();
    expect(f.fileOffsets).toEqual([0, 0, FLEET_MAIL_FILE_CHUNK_BYTES]);
    expect(f.a.journal.outgoing(value.messageId)?.state).toBe("unknown");
    expect(f.b.db.prepare("SELECT * FROM fixture_file_copies").all()).toEqual([
      { id: value.files[0].fileId, bytes },
    ]);
    f.restartClient();
    f.mode("normal");
    const final = await f.client.deliver(
      value.messageId,
      allowed,
      undefined,
      () => {
        throw new Error("Accepted copies must not be reread");
      },
    );
    expect(final.delivery.receipt?.admission.state).toBe("accepted");
    expect(f.fileOffsets).toHaveLength(3);
    expect(accepts(f)).toBe(1);
    expect(
      f.b.db.prepare("SELECT count(*) n FROM fixture_mail_queue").get(),
    ).toEqual({ n: 1 });
    expect(
      f.b.db.prepare("SELECT count(*) n FROM fleet_mail_files").get(),
    ).toEqual({ n: 0 });
  } finally {
    await f.close();
  }
});

it("rejects a changed signed file acknowledgement before mail acceptance", async () => {
  const f = await fixture();
  try {
    const bytes = randomBytes(FLEET_MAIL_FILE_CHUNK_BYTES + 9);
    const value = attach(f.envelope(), bytes);
    f.a.journal.enqueue(value, allowed);
    f.mode("tampered-file");
    await expect(
      f.client.deliver(value.messageId, allowed, undefined, () => bytes),
    ).rejects.toMatchObject({ status: 502 });
    expect(accepts(f)).toBe(0);
    expect(
      f.b.db.prepare("SELECT count(*) n FROM fixture_file_copies").get(),
    ).toEqual({ n: 0 });
    f.mode("normal");
    expect(
      (await f.client.deliver(value.messageId, allowed, undefined, () => bytes))
        .delivery.receipt?.admission.state,
    ).toBe("accepted");
  } finally {
    await f.close();
  }
});

it("does not send file bytes under a mail-only local grant", async () => {
  const f = await fixture(["read", "mail"]);
  try {
    const bytes = Buffer.from("Denied");
    const value = attach(f.envelope(), bytes);
    f.a.journal.enqueue(value, allowed);
    await expect(
      f.client.deliver(value.messageId, allowed, undefined, () => bytes),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.fileOffsets).toEqual([]);
    expect(accepts(f)).toBe(0);
    expect(
      f.b.db.prepare("SELECT count(*) n FROM fixture_file_copies").get(),
    ).toEqual({ n: 0 });
  } finally {
    await f.close();
  }
});

it("reclaims completed incoming capacity without sender receipt polling and retains admission identities", async () => {
  const f = await fixture();
  try {
    const values = Array.from({ length: FLEET_MAIL_PEER_PENDING }, f.envelope);
    const credential = await f.token("mail");
    const reservations: string[] = [];
    for (const value of values) {
      const prepared = f.service.prepare({
        version: 1,
        requestId: randomUUID(),
        credential,
        offer: {
          source: value.source.machineId,
          destination: value.destination.machineId,
          messageId: value.messageId,
          payloadDigest: fleetPayloadDigest(value),
          authority: value.authority,
        },
      });
      const admission = prepared.response.receipt!.admission;
      if (admission.state !== "prepared")
        throw new Error("fixture preparation");
      reservations.push(admission.reservationId);
      f.service.accept({
        version: 1,
        requestId: randomUUID(),
        credential,
        envelope: value,
        reservationId: admission.reservationId,
      });
    }
    const value = f.envelope();
    const input = {
      version: 1,
      requestId: randomUUID(),
      credential,
      offer: {
        source: value.source.machineId,
        destination: value.destination.machineId,
        messageId: value.messageId,
        payloadDigest: fleetPayloadDigest(value),
        authority: value.authority,
      },
    };
    const path = "/api" + fleetMailApi.prepare.path;
    expect((await f.call(path, input)).status).toBe(429);
    f.complete();
    const prepared = await f.call(path, input);
    expect(prepared.status).toBe(200);
    expect(prepared.body.response.receipt.admission.state).toBe("prepared");
    expect(
      f.calls.filter((p) => p === "/api" + fleetMailApi.receipt.path),
    ).toHaveLength(0);
    expect(
      f.b.db.prepare("SELECT count(*) n FROM fixture_mail_queue").get(),
    ).toEqual({ n: FLEET_MAIL_PEER_PENDING });
    expect(
      f.b.db
        .prepare("SELECT count(*) n FROM fleet_mail_inbox WHERE settled=1")
        .get(),
    ).toEqual({ n: FLEET_MAIL_PEER_PENDING });
    const duplicate = await f.call("/api" + fleetMailApi.accept.path, {
      version: 1,
      requestId: randomUUID(),
      credential: input.credential,
      envelope: values[0],
      reservationId: reservations[0],
    });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.response.receipt).toMatchObject({
      messageId: values[0].messageId,
      revision: 3,
      admission: { state: "accepted", status: "handled" },
    });
    expect(
      f.b.db.prepare("SELECT count(*) n FROM fixture_mail_queue").get(),
    ).toEqual({ n: FLEET_MAIL_PEER_PENDING });
  } finally {
    await f.close();
  }
});

it("parks an offline envelope before transmission and sends the same identity after signed address repair", async () => {
  const f = await fixture();
  try {
    const value = f.envelope();
    f.a.journal.enqueue(value, allowed);
    f.mode("offline");
    await expect(f.client.deliver(value.messageId, allowed)).rejects.toThrow();
    expect(f.a.journal.outgoing(value.messageId)?.state).toBe("pending");
    expect(accepts(f)).toBe(0);
    f.mode("normal");
    await f.repair();
    expect(
      (await f.client.deliver(value.messageId, allowed)).delivery.receipt
        ?.messageId,
    ).toBe(value.messageId);
    expect(accepts(f)).toBe(1);
  } finally {
    await f.close();
  }
});

it.each(["before-accept", "destination-busy"] as const)(
  "reconciles a durable preparation after %s without replacing the message or dispatching twice",
  async (mode) => {
    const f = await fixture();
    try {
      const value = f.envelope();
      f.a.journal.enqueue(value, allowed);
      f.mode(mode);
      await expect(
        f.client.deliver(value.messageId, allowed),
      ).rejects.toThrow();
      expect(f.a.journal.outgoing(value.messageId)?.state).toBe("unknown");
      expect(
        f.b.db.prepare("SELECT count(*) n FROM fixture_mail_queue").get(),
      ).toEqual({ n: 0 });
      f.restartClient();
      await delay(f.capacity.retryAfter(f.origin) + 20);
      f.mode("missing");
      expect(
        (await f.client.deliver(value.messageId, allowed)).receiptAvailable,
      ).toBe(false);
      expect(accepts(f)).toBe(1);
      expect(f.a.journal.outgoing(value.messageId)?.state).toBe("unknown");
      await f.repair();
      f.mode("normal");
      expect(
        (await f.client.deliver(value.messageId, allowed)).delivery,
      ).toMatchObject({
        state: "accepted",
        messageId: value.messageId,
      });
      expect(f.sentEnvelopes).toEqual([value, value]);
      expect(new Set(f.sentReservations).size).toBe(1);
      expect(
        f.b.db.prepare("SELECT count(*) n FROM fixture_mail_queue").get(),
      ).toEqual({ n: 1 });
      await f.client.deliver(value.messageId, allowed);
      expect(accepts(f)).toBe(2);
    } finally {
      await f.close();
    }
  },
);

it("rejects a forged preparation and recovers its lost response before any envelope transmission", async () => {
  const f = await fixture();
  try {
    const value = f.envelope();
    f.a.journal.enqueue(value, allowed);
    for (const mode of ["tampered-prepare", "lost-prepare"] as const) {
      f.mode(mode);
      await expect(
        f.client.deliver(value.messageId, allowed),
      ).rejects.toMatchObject({ status: 502 });
      expect(f.a.journal.outgoing(value.messageId)?.state).toBe("pending");
      expect(accepts(f)).toBe(0);
    }
    const row = f.b.db
      .prepare("SELECT admission FROM fleet_mail_inbox WHERE message_id=?")
      .get(value.messageId) as { admission: string };
    const original = JSON.parse(row.admission).reservationId;
    f.restartClient();
    f.mode("normal");
    expect(
      (await f.client.deliver(value.messageId, allowed)).delivery.state,
    ).toBe("accepted");
    expect(f.sentReservations).toEqual([original]);
    expect(
      f.b.db.prepare("SELECT count(*) n FROM fixture_mail_queue").get(),
    ).toEqual({ n: 1 });
  } finally {
    await f.close();
  }
});

it("keeps an expired reservation refused after uncertainty and rejects its late envelope", async () => {
  const f = await fixture();
  try {
    const value = f.envelope();
    f.a.journal.enqueue(value, allowed);
    f.mode("before-accept");
    await expect(f.client.deliver(value.messageId, allowed)).rejects.toThrow();
    f.expireReservation();
    f.mode("normal");
    expect(
      (await f.client.deliver(value.messageId, allowed)).delivery,
    ).toMatchObject({
      state: "refused",
      settled: true,
      receipt: { admission: { state: "refused", reason: "expired" } },
    });
    const late = await f.call("/api" + fleetMailApi.accept.path, {
      version: 1,
      requestId: randomUUID(),
      credential: await f.token("mail"),
      envelope: value,
      reservationId: f.sentReservations[0],
    });
    expect(late.status).toBe(200);
    expect(late.body.response.receipt.admission).toEqual({
      state: "refused",
      reason: "expired",
    });
    expect(accepts(f)).toBe(1);
    expect(
      f.b.db.prepare("SELECT count(*) n FROM fixture_mail_queue").get(),
    ).toEqual({ n: 0 });
  } finally {
    await f.close();
  }
});

it("proves the destination key before sending any scoped credential or message body", async () => {
  const f = await fixture();
  try {
    const value = f.envelope();
    f.a.journal.enqueue(value, allowed);
    f.mode("wrong-key");
    await expect(f.client.deliver(value.messageId, allowed)).rejects.toThrow();
    expect(f.calls).toEqual(["/api" + fleetPeerApi.enrollmentProbe.path]);
    expect(f.a.journal.outgoing(value.messageId)?.state).toBe("pending");
  } finally {
    await f.close();
  }
});

it("keeps local capacity refusals unsent and reconciles a rolled-back admission before retrying the same identity", async () => {
  const f = await fixture();
  const held: (() => void)[] = [];
  try {
    const value = f.envelope();
    f.a.journal.enqueue(value, allowed);
    for (let i = 0; i < 4; i++)
      held.push(f.capacity.acquire("outbound", f.origin)!);
    await expect(
      f.transport.accept(
        f.origin,
        {
          version: 1,
          requestId: randomUUID(),
          credential: secret(),
          envelope: value,
          reservationId: randomUUID(),
        },
        new AbortController().signal,
        () => {
          f.a.journal.beginTransmission(value.messageId, allowed);
        },
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(f.a.journal.outgoing(value.messageId)?.state).toBe("pending");
    expect(f.calls).toEqual([]);
    for (const release of held.splice(0)) release();
    f.failAdmission();
    await expect(f.client.deliver(value.messageId, allowed)).rejects.toThrow();
    expect(
      f.b.db.prepare("SELECT count(*) n FROM fixture_mail_queue").get(),
    ).toEqual({ n: 0 });
    expect(
      f.b.db.prepare("SELECT count(*) n FROM fleet_mail_inbox").get(),
    ).toEqual({ n: 1 });
    expect(f.a.journal.outgoing(value.messageId)?.state).toBe("unknown");
    // A 5xx reply alone cannot authorize replay. The sender first asks the
    // destination for its original durable preparation after the cooldown.
    expect(f.a.journal.pendingEnvelope(value.messageId)).toBeNull();
    expect(accepts(f)).toBe(1);
    f.failAdmission(false);
    await delay(f.capacity.retryAfter(f.origin) + 20);
    expect(
      (await f.client.deliver(value.messageId, allowed)).delivery.state,
    ).toBe("accepted");
    expect(f.sentEnvelopes).toEqual([value, value]);
    expect(
      f.b.db.prepare("SELECT count(*) n FROM fixture_mail_queue").get(),
    ).toEqual({ n: 1 });
  } finally {
    for (const release of held) release();
    await f.close();
  }
});

it("fences a late directory result when its requesting run or owner is no longer current", async () => {
  const f = await fixture();
  let release!: () => void,
    began!: () => void,
    current = true;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    f.blockDirectory(gate, began);
    const read = f.client.directory(
      f.b.authority.identity.machineId,
      {},
      () => {
        if (!current) throw new Error("fixture run changed");
      },
    );
    await started;
    current = false;
    release();
    await expect(read).rejects.toThrow("run changed");
  } finally {
    release();
    await f.close();
  }
});

it("requires mail scope and machine admission, and leaves unconfigured mail routes inaccessible", async () => {
  const f = await fixture();
  try {
    const input = {
      version: 1,
      requestId: randomUUID(),
      credential: await f.token("read"),
      query: {},
    };
    const path = "/api" + fleetMailApi.directory.path;
    expect((await f.call(path, input)).status).toBe(403);
    input.credential = await f.token("mail");
    const forbiddenHeaders: Record<string, string>[] = [
      { origin: f.origin },
      { cookie: "fixture=browser" },
      { authorization: "Bearer fixture" },
      { "sec-fetch-mode": "cors" },
      { host: "unrelated.example" },
    ];
    for (const headers of forbiddenHeaders)
      expect((await f.call(path, input, headers)).status).toBe(403);
    expect((await f.call(path, { ...input, owner: f.a.owner })).status).toBe(
      400,
    );
    expect((await f.call(path + "?owner=foreign", input)).status).toBe(404);
    expect((await f.call(path, input)).status).toBe(200);
    f.disable();
    expect((await f.call(path, input)).status).toBe(404);
    expect(f.workspaceCalls).toBe(0);
  } finally {
    await f.close();
  }
});
