import { afterAll, expect, it } from "vitest";
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations } from "../src/server/migrations.js";
import { FleetAuthority } from "../src/server/fleet-authority.js";
import { FleetMailJournal } from "../src/server/fleet-mail-journal.js";
import {
  directoryDigest,
  fleetPayloadDigest,
} from "../src/server/fleet-crypto.js";
import {
  FleetMailEnvelope,
  FLEET_MAIL_PENDING,
  FLEET_MAIL_PREPARE_MS,
  fleetAgentAddress,
  parseFleetAgentAddress,
  type FleetMailAdmission,
  type FleetMailReceipt,
} from "../src/shared/fleet-mail.js";
import type { FleetGrantContext, FleetOperation } from "../src/shared/fleet.js";

const root = mkdtempSync(join(tmpdir(), "loop55-fleet-mail-"));
process.env.LOOP55_PROFILE = "companion";
process.env.LOOP55_DATA_DIR = root;
process.env.LOOP55_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const secrets = await import("../src/server/secrets.js");
// Migration work is fixture setup, not the admission/commit being measured.
const template = new Database(":memory:");
applyMigrations(template);
const seed = template.serialize();
template.close();
const databases: Database.Database[] = [];
afterAll(() => {
  for (const db of databases) if (db.open) db.close();
  rmSync(root, { recursive: true, force: true });
});
function machine(owner: string) {
  const path = join(root, randomUUID() + ".db");
  writeFileSync(path, seed);
  const db = new Database(path);
  databases.push(db);
  db.pragma("foreign_keys=ON");
  db.prepare("INSERT INTO deployment_profile VALUES(1,'companion')").run();
  db.exec(
    "CREATE TABLE fixture_queue(id TEXT PRIMARY KEY, body TEXT NOT NULL)",
  );
  const authority = new FleetAuthority(db, secrets);
  return {
    path,
    db,
    owner,
    authority,
    journal: new FleetMailJournal(db, authority, owner),
  };
}
type Machine = ReturnType<typeof machine>;
const scopes: FleetOperation[] = ["read", "mail", "files"];
function pair(scope = scopes) {
  const a = machine("owner-A"),
    b = machine("independent-owner-B");
  const initial = a.authority.create(a.owner, {
    mutationId: randomUUID(),
    name: "Same name",
    origin: "https://a.example",
    scope: scopes,
  });
  const directory = a.authority.revise(a.owner, {
    mutationId: randomUUID(),
    expected: a.authority.status(a.owner).head!,
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
  b.authority.approve(b.owner, {
    mutationId: randomUUID(),
    expected: null,
    kind: "enroll",
    scope,
    controller: a.authority.identity,
    directory,
    grantId: directory.document.members[1].grantId,
  });
  return { a, b };
}
function context(a: Machine, b: Machine): FleetGrantContext {
  const doc = b.authority.directory(b.owner)!.document;
  return {
    fleetId: doc.fleetId,
    grantId: doc.members.find(
      (m) => m.machineId === b.authority.identity.machineId,
    )!.grantId,
    destination: b.authority.identity.machineId,
    peer: a.authority.identity.machineId,
    directory: directoryDigest(doc),
    operation: "mail",
  };
}
function envelope(a: Machine, b: Machine) {
  const doc = a.authority.directory(a.owner)!.document;
  return FleetMailEnvelope.parse({
    version: 1,
    messageId: randomUUID(),
    source: {
      machineId: a.authority.identity.machineId,
      agentId: randomUUID(),
    },
    destination: {
      machineId: b.authority.identity.machineId,
      agentId: randomUUID(),
    },
    authority: {
      fleetId: doc.fleetId,
      directory: directoryDigest(doc),
      sourceGrantId: doc.members.find(
        (m) => m.machineId === a.authority.identity.machineId,
      )!.grantId,
      destinationGrantId: doc.members.find(
        (m) => m.machineId === b.authority.identity.machineId,
      )!.grantId,
    },
    sender: {
      name: "Same agent label",
      runId: randomUUID(),
      conversationId: randomUUID(),
    },
    thread: {
      origin: a.authority.identity.machineId,
      id: randomUUID(),
      subject: "Fixture",
      recipientConversationId: null,
    },
    body: "One-hop fixture message",
    interrupt: false,
    files: [],
  });
}
function admit(b: Machine, value: FleetMailEnvelope): FleetMailAdmission {
  const mailId = randomUUID();
  b.db.prepare("INSERT INTO fixture_queue VALUES(?,?)").run(mailId, value.body);
  return {
    state: "accepted",
    mailId,
    threadId: randomUUID(),
    conversationId: randomUUID(),
    status: "queued",
  };
}
const allowed = () => {};
const reference = (value: FleetMailEnvelope) => ({
  source: value.source.machineId,
  messageId: value.messageId,
  payloadDigest: fleetPayloadDigest(value),
});
const offer = (value: FleetMailEnvelope) => ({
  ...reference(value),
  destination: value.destination.machineId,
  authority: value.authority,
});

it("persists preparation without queueing and permits only the same reserved envelope after reconciliation", () => {
  const { a, b } = pair(),
    value = envelope(a, b),
    grant = context(a, b);
  a.journal.enqueue(value, allowed);
  const prepared = b.journal.prepare(grant, offer(value));
  expect(prepared.admission.state).toBe("prepared");
  if (prepared.admission.state !== "prepared") throw new Error("not prepared");
  const reservationId = prepared.admission.reservationId;
  expect(b.journal.prepare(grant, offer(value))).toEqual(prepared);
  expect(() =>
    b.journal.prepare(grant, {
      ...offer(value),
      payloadDigest: "a".repeat(64),
    }),
  ).toThrow();
  expect(b.db.prepare("SELECT count(*) n FROM fixture_queue").get()).toEqual({
    n: 0,
  });
  a.journal.recordReceipt(value.messageId, prepared);
  expect(
    a.journal.beginPreparedTransmission(
      value.messageId,
      reservationId,
      allowed,
    ),
  ).toEqual(value);
  expect(a.journal.outgoing(value.messageId)).toMatchObject({
    state: "unknown",
    receipt: null,
  });
  expect(
    a.journal.beginPreparedTransmission(
      value.messageId,
      reservationId,
      allowed,
    ),
  ).toBeNull();
  expect(a.journal.preparedEnvelope(value.messageId, reservationId)).toBeNull();
  expect(() =>
    b.journal.accept(grant, value, (mail) => admit(b, mail), randomUUID()),
  ).toThrow();
  expect(() =>
    b.journal.accept(
      grant,
      value,
      (mail) => {
        admit(b, mail);
        throw new Error("fixture rollback after queue write");
      },
      reservationId,
    ),
  ).toThrow("fixture rollback");
  expect(b.db.prepare("SELECT count(*) n FROM fixture_queue").get()).toEqual({
    n: 0,
  });
  b.db.close();
  const db = new Database(b.path);
  databases.push(db);
  const restarted = new FleetMailJournal(
    db,
    new FleetAuthority(db, secrets),
    b.owner,
  );
  const reconciled = restarted.receipt(grant, reference(value), () => {
    throw new Error("preparation is not accepted mail");
  });
  expect(reconciled).toEqual(prepared);
  a.journal.recordReceipt(value.messageId, reconciled);
  expect(
    a.journal.beginPreparedTransmission(
      value.messageId,
      reservationId,
      allowed,
    ),
  ).toEqual(value);
  const accepted = restarted.accept(
    grant,
    value,
    (mail) => admit({ ...b, db }, mail),
    reservationId,
  );
  expect(accepted.revision).toBe(2);
  expect(
    restarted.accept(
      grant,
      value,
      () => {
        throw new Error("duplicate queue write");
      },
      reservationId,
    ),
  ).toEqual(accepted);
  a.journal.recordReceipt(value.messageId, accepted);
  expect(a.journal.recordReceipt(value.messageId, prepared).state).toBe(
    "accepted",
  );
  expect(a.journal.preparedEnvelope(value.messageId, reservationId)).toBeNull();
  expect(db.prepare("SELECT count(*) n FROM fixture_queue").get()).toEqual({
    n: 1,
  });
});

it("expires bounded reservations into durable refusals without granting queue or context access", () => {
  const { a, b } = pair(),
    value = envelope(a, b),
    grant = context(a, b);
  let now = Date.now();
  const journal = new FleetMailJournal(b.db, b.authority, b.owner, () => now);
  const first = journal.prepare(grant, offer(value));
  if (first.admission.state !== "prepared") throw new Error("not prepared");
  for (let i = 1; i < 100; i++)
    journal.prepare(grant, offer({ ...value, messageId: randomUUID() }));
  const later = { ...value, messageId: randomUUID() };
  expect(() => journal.prepare(grant, offer(later))).toThrow(
    "too much pending",
  );
  now += FLEET_MAIL_PREPARE_MS;
  const expired = journal.receipt(grant, reference(value), () => {
    throw new Error("unadmitted content inspected");
  });
  expect(expired).toMatchObject({
    revision: 2,
    admission: { state: "refused", reason: "expired" },
  });
  expect(
    journal.accept(
      grant,
      value,
      () => {
        throw new Error("expired reservation admitted");
      },
      first.admission.reservationId,
    ),
  ).toEqual(expired);
  expect(journal.prepare(grant, offer(value))).toEqual(expired);
  expect(journal.prepare(grant, offer(later)).admission.state).toBe("prepared");
  expect(
    b.db
      .prepare("SELECT count(*) n FROM fleet_mail_inbox WHERE settled=0")
      .get(),
  ).toEqual({ n: 1 });
  expect(b.db.prepare("SELECT count(*) n FROM fleet_mail_inbox").get()).toEqual(
    { n: 101 },
  );
  expect(b.db.prepare("SELECT count(*) n FROM fixture_queue").get()).toEqual({
    n: 0,
  });
});

it("atomically admits one queue row across duplicate envelopes, restart and a lost reply", () => {
  const { a, b } = pair(),
    value = envelope(a, b);
  expect(a.journal.enqueue(value, allowed).state).toBe("pending");
  expect(a.journal.beginTransmission(value.messageId, allowed)).toEqual(value);
  const receipt = b.journal.accept(context(a, b), value, (mail) =>
    admit(b, mail),
  );
  expect(
    b.journal.accept(context(a, b), value, () => {
      throw new Error("duplicate admitted");
    }),
  ).toEqual(receipt);
  const authorization = context(a, b);
  b.db.close();
  const db = new Database(b.path);
  databases.push(db);
  const restarted = new FleetMailJournal(
    db,
    new FleetAuthority(db, secrets),
    b.owner,
  );
  expect(
    restarted.accept(authorization, value, () => {
      throw new Error("restarted duplicate admitted");
    }),
  ).toEqual(receipt);
  expect(db.prepare("SELECT count(*) n FROM fixture_queue").get()).toEqual({
    n: 1,
  });
  expect(a.journal.outgoing(value.messageId)?.state).toBe("unknown");
  expect(a.journal.beginTransmission(value.messageId, allowed)).toBeNull();
  const received = restarted.receipt(
    authorization,
    reference(value),
    (prior) => prior,
  )!;
  expect(a.journal.recordReceipt(value.messageId, received).state).toBe(
    "accepted",
  );
  expect(db.prepare("SELECT count(*) n FROM agents").get()).toEqual({ n: 0 });
});

it("rolls back queue work and inbox identity together when admission cannot commit", () => {
  const { a, b } = pair(),
    value = envelope(a, b);
  expect(() =>
    b.journal.accept(context(a, b), value, (mail) => {
      admit(b, mail);
      throw new Error("fixture crash before commit");
    }),
  ).toThrow("fixture crash");
  expect(b.db.prepare("SELECT count(*) n FROM fixture_queue").get()).toEqual({
    n: 0,
  });
  expect(
    b.journal.receipt(context(a, b), reference(value), () => {
      throw new Error("missing inbox inspected");
    }),
  ).toBeNull();
  expect(
    b.journal.accept(context(a, b), value, (mail) => admit(b, mail)).admission
      .state,
  ).toBe("accepted");
  expect(b.db.prepare("SELECT count(*) n FROM fixture_queue").get()).toEqual({
    n: 1,
  });
});

it("binds sender attribution, owner, scope, payload and recipient to the original identity", () => {
  const { a, b } = pair(),
    value = envelope(a, b);
  a.journal.enqueue(value, allowed);
  b.journal.accept(context(a, b), value, (mail) => admit(b, mail));
  for (const changed of [
    { ...value, body: "replacement body" },
    { ...value, destination: { ...value.destination, agentId: randomUUID() } },
    { ...value, sender: { ...value.sender, runId: randomUUID() } },
    {
      ...value,
      thread: { ...value.thread, recipientConversationId: randomUUID() },
    },
  ]) {
    expect(() => a.journal.enqueue(changed, allowed)).toThrow(
      "different input",
    );
    expect(() =>
      b.journal.accept(context(a, b), changed, () => {
        throw new Error("replaced");
      }),
    ).toThrow("different input");
  }
  const foreign = machine("other owner");
  expect(() =>
    b.journal.accept(
      context(a, b),
      {
        ...value,
        source: {
          ...value.source,
          machineId: foreign.authority.identity.machineId,
        },
      },
      () => {
        throw new Error("forged");
      },
    ),
  ).toThrow();
  expect(() =>
    new FleetMailJournal(b.db, b.authority, a.owner).accept(
      context(a, b),
      value,
      allowed as never,
    ),
  ).toThrow();
  expect(() =>
    b.journal.accept(
      { ...context(a, b), operation: "read" },
      value,
      allowed as never,
    ),
  ).toThrow();
  expect(b.db.prepare("SELECT count(*) n FROM fixture_queue").get()).toEqual({
    n: 1,
  });
  const without = pair(["read"]);
  expect(() =>
    without.b.journal.accept(
      context(without.a, without.b),
      envelope(without.a, without.b),
      allowed as never,
    ),
  ).toThrow();
});

it("keeps the original envelope through address repair and fences removed grants before transmission", () => {
  const { a, b } = pair(),
    value = envelope(a, b);
  a.journal.enqueue(value, allowed);
  const doc = a.authority.directory(a.owner)!;
  const repaired = a.authority.revise(a.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(doc.document),
    members: doc.document.members.map((m) =>
      m.machineId === b.authority.identity.machineId
        ? { ...m, origin: "https://repaired.example" }
        : m,
    ),
  });
  b.authority.accept(b.owner, repaired);
  expect(a.journal.beginTransmission(value.messageId, allowed)).toEqual(value);
  const receipt = b.journal.accept(context(a, b), value, (mail) =>
    admit(b, mail),
  );
  a.journal.recordReceipt(value.messageId, receipt);
  const pending = envelope(a, b);
  a.journal.enqueue(pending, allowed);
  a.authority.revise(a.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(repaired.document),
    members: repaired.document.members.filter(
      (m) => m.machineId !== b.authority.identity.machineId,
    ),
  });
  expect(() => a.journal.beginTransmission(pending.messageId, allowed)).toThrow(
    "grant",
  );
  expect(a.journal.outgoing(pending.messageId)?.state).toBe("pending");
  expect(() => a.journal.recordReceipt(value.messageId, receipt)).toThrow(
    "grant",
  );
});

it("rechecks sender policy before durable send and never resends an unknown receipt after restart", () => {
  const { a, b } = pair(),
    value = envelope(a, b);
  a.journal.enqueue(value, allowed);
  expect(() =>
    a.journal.beginTransmission(value.messageId, () => {
      throw new Error("sender cancelled");
    }),
  ).toThrow("cancelled");
  expect(a.journal.outgoing(value.messageId)?.state).toBe("pending");
  a.journal.beginTransmission(value.messageId, allowed);
  a.db.close();
  const db = new Database(a.path);
  databases.push(db);
  const restarted = new FleetMailJournal(
    db,
    new FleetAuthority(db, secrets),
    a.owner,
  );
  expect(restarted.beginTransmission(value.messageId, allowed)).toBeNull();
  expect(restarted.outgoing(value.messageId)?.state).toBe("unknown");
  expect(restarted.refuseUnsent(value.messageId, "cancelled")).toBe(false);
  expect(
    b.journal.receipt(context(a, b), reference(value), allowed as never),
  ).toBeNull();
  expect(restarted.beginTransmission(value.messageId, allowed)).toBeNull();
});

it("retires a cancelled unsent message without turning a later retry into new work", () => {
  const { a, b } = pair(),
    value = envelope(a, b);
  a.journal.enqueue(value, allowed);
  expect(a.journal.refuseUnsent(value.messageId, "cancelled")).toBe(true);
  expect(a.journal.enqueue(value, allowed)).toMatchObject({
    state: "refused",
    settled: true,
    localRefusal: "cancelled",
    receipt: null,
  });
  expect(a.journal.beginTransmission(value.messageId, allowed)).toBeNull();
  expect(b.db.prepare("SELECT count(*) n FROM fixture_queue").get()).toEqual({
    n: 0,
  });
  const claimed = b.journal.accept(context(a, b), value, (mail) =>
    admit(b, mail),
  );
  expect(() => a.journal.recordReceipt(value.messageId, claimed)).toThrow(
    "different input",
  );
});

it("orders receipt observations and preserves the accepted conversation and compacted identity", () => {
  const { a, b } = pair(),
    value = envelope(a, b);
  a.journal.enqueue(value, allowed);
  a.journal.beginTransmission(value.messageId, allowed);
  const first = b.journal.accept(context(a, b), value, (mail) =>
    admit(b, mail),
  );
  a.journal.recordReceipt(value.messageId, first);
  const final = b.journal.receipt(
    context(a, b),
    reference(value),
    (prior) => ({ ...prior, status: "handled" }) as FleetMailAdmission,
  )!;
  expect(final.revision).toBe(2);
  expect(a.journal.recordReceipt(value.messageId, final).settled).toBe(true);
  expect(a.journal.recordReceipt(value.messageId, first).receipt).toEqual(
    final,
  );
  expect(
    a.db
      .prepare("SELECT envelope FROM fleet_mail_outbox WHERE message_id=?")
      .get(value.messageId),
  ).toEqual({ envelope: null });
  expect(
    a.journal.enqueue(value, () => {
      throw new Error("recreated");
    }).receipt,
  ).toEqual(final);
  const rebound: FleetMailReceipt = {
    ...final,
    revision: 3,
    admission: {
      ...final.admission,
      conversationId: randomUUID(),
    } as FleetMailAdmission,
  };
  expect(() => a.journal.recordReceipt(value.messageId, rebound)).toThrow(
    "different input",
  );
  const reboundAdmission = rebound.admission;
  if (reboundAdmission.state !== "accepted") throw new Error("not accepted");
  expect(() =>
    b.journal.receipt(context(a, b), reference(value), () => reboundAdmission),
  ).toThrow("different input");
  expect(() =>
    a.journal.recordReceipt(value.messageId, {
      ...final,
      admission: { ...final.admission, status: "queued" },
    }),
  ).toThrow("different input");
  expect(a.journal.beginTransmission(value.messageId, allowed)).toBeNull();
});

it("bounds active owner queues and retains refused identities without dispatch", () => {
  const { a, b } = pair(),
    first = envelope(a, b);
  const values = Array.from({ length: 100 }, () => ({
    ...first,
    messageId: randomUUID(),
  }));
  a.db.transaction(() => {
    for (const value of values) a.journal.enqueue(value, allowed);
  })();
  expect(() =>
    a.journal.enqueue({ ...first, messageId: randomUUID() }, allowed),
  ).toThrow("pending fleet mail");
  b.db.transaction(() => {
    for (const value of values)
      b.journal.accept(context(a, b), value, (mail) => admit(b, mail));
  })();
  expect(() =>
    b.journal.accept(
      context(a, b),
      { ...first, messageId: randomUUID() },
      (mail) => admit(b, mail),
    ),
  ).toThrow("pending fleet mail");
  b.journal.receipt(
    context(a, b),
    reference(values[0]),
    (prior) => ({ ...prior, status: "handled" }) as FleetMailAdmission,
  );
  const refused = b.journal.accept(context(a, b), first, () => ({
    state: "refused",
    reason: "recipient_unavailable",
  }));
  expect(
    b.journal.accept(context(a, b), first, (mail) => admit(b, mail)),
  ).toEqual(refused);
  expect(
    b.journal.receipt(context(a, b), reference(first), () => {
      throw new Error("refused mail replayed");
    }),
  ).toEqual(refused);
  expect(b.db.prepare("SELECT count(*) n FROM fixture_queue").get()).toEqual({
    n: 100,
  });
});

it("settles only owning admissions after sender removal and rolls back invalid inspection", () => {
  const { a, b } = pair(),
    c = machine("owner-C");
  const first = a.authority.directory(a.owner)!;
  const enrolled = a.authority.revise(a.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(first.document),
    members: [
      ...first.document.members,
      {
        ...c.authority.identity,
        grantId: randomUUID(),
        name: "Third peer",
        origin: "https://c.example",
      },
    ],
  });
  c.authority.approve(c.owner, {
    mutationId: randomUUID(),
    expected: null,
    kind: "enroll",
    scope: scopes,
    controller: a.authority.identity,
    directory: enrolled,
    grantId: enrolled.document.members[2].grantId,
  });
  b.authority.accept(b.owner, enrolled);
  const removed = envelope(c, b),
    formerContext = context(c, b);
  const accepted = b.journal.accept(formerContext, removed, (mail) =>
    admit(b, mail),
  );
  if (accepted.admission.state !== "accepted")
    throw new Error("fixture admission");
  const completedId = accepted.admission.mailId;
  b.db.transaction(() => {
    for (let i = 1; i < FLEET_MAIL_PENDING; i++)
      b.journal.accept(context(a, b), envelope(a, b), (mail) => admit(b, mail));
  })();
  b.db
    .prepare(
      `INSERT INTO fleet_mail_inbox
    SELECT 'foreign-owner',peer_id,message_id,fleet_id,source_grant_id,
    destination_grant_id,payload_digest,admission,revision,settled,created_at,updated_at
    FROM fleet_mail_inbox WHERE owner_id=? AND message_id=?`,
    )
    .run(b.owner, removed.messageId);
  const foreign = b.db
    .prepare("SELECT * FROM fleet_mail_inbox WHERE owner_id='foreign-owner'")
    .get();
  const revised = a.authority.revise(a.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(enrolled.document),
    members: enrolled.document.members.filter(
      (m) => m.machineId !== c.authority.identity.machineId,
    ),
  });
  b.authority.accept(b.owner, revised);
  expect(() =>
    b.journal.receipt(formerContext, reference(removed), (prior) => prior),
  ).toThrow();
  const value = envelope(a, b),
    current = context(a, b);
  expect(() =>
    b.journal.prepare(current, offer(value), (prior) => prior),
  ).toThrow("pending fleet mail");
  let inspected = 0;
  expect(() =>
    b.journal.prepare(current, offer(value), (prior) => {
      if (prior.state !== "accepted") throw new Error("fixture admission");
      return {
        ...prior,
        status: "handled",
        mailId: ++inspected === 2 ? randomUUID() : prior.mailId,
      };
    }),
  ).toThrow("different input");
  expect(
    b.db
      .prepare("SELECT count(*) n FROM fleet_mail_inbox WHERE settled=1")
      .get(),
  ).toEqual({ n: 0 });
  inspected = 0;
  const prepared = b.journal.prepare(current, offer(value), (prior) => {
    inspected++;
    return prior.state === "accepted" && prior.mailId === completedId
      ? { ...prior, status: "handled" }
      : prior;
  });
  expect(prepared.admission.state).toBe("prepared");
  expect(inspected).toBe(FLEET_MAIL_PENDING);
  expect(
    b.db
      .prepare(
        "SELECT settled,revision,admission FROM fleet_mail_inbox WHERE owner_id=? AND message_id=?",
      )
      .get(b.owner, removed.messageId),
  ).toEqual({
    settled: 1,
    revision: 2,
    admission: JSON.stringify({ ...accepted.admission, status: "handled" }),
  });
  expect(
    b.db
      .prepare("SELECT * FROM fleet_mail_inbox WHERE owner_id='foreign-owner'")
      .get(),
  ).toEqual(foreign);
  expect(b.db.prepare("SELECT count(*) n FROM fixture_queue").get()).toEqual({
    n: FLEET_MAIL_PENDING,
  });
});

it("uses canonical source-qualified addresses and refuses relay, path and oversized envelopes", () => {
  const { a, b } = pair(),
    value = envelope(a, b);
  expect(parseFleetAgentAddress(fleetAgentAddress(value.destination))).toEqual(
    value.destination,
  );
  expect(parseFleetAgentAddress(value.destination.agentId)).toBeUndefined();
  expect(() => parseFleetAgentAddress("peer:wrong:agent")).toThrow();
  expect(
    FleetMailEnvelope.safeParse({ ...value, source: value.destination })
      .success,
  ).toBe(false);
  const file = {
    source: a.authority.identity.machineId,
    fileId: randomUUID(),
    digest: "a".repeat(64),
    bytes: 10,
    name: "fixture.txt",
    mediaType: "text/plain",
  };
  expect(
    FleetMailEnvelope.safeParse({
      ...value,
      files: [{ ...file, source: b.authority.identity.machineId }],
    }).success,
  ).toBe(false);
  expect(
    FleetMailEnvelope.safeParse({
      ...value,
      files: [{ ...file, name: "../private" }],
    }).success,
  ).toBe(false);
  expect(
    FleetMailEnvelope.safeParse({ ...value, body: "\u0000".repeat(12000) })
      .success,
  ).toBe(false);
  b.db.prepare("UPDATE deployment_profile SET profile='server'").run();
  expect(() =>
    b.journal.accept(context(a, b), value, (mail) => admit(b, mail)),
  ).toThrow();
});
