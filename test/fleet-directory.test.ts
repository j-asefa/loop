import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  directoryDigest,
  generateMachineKey,
  signDirectory,
  validateDirectory,
  verifyDirectoryRoot,
  verifyDirectorySuccessor,
} from "../src/server/fleet-crypto.js";
import {
  FleetCapabilities,
  FleetOrigin,
  type FleetDirectory,
  type SignedFleetDirectory,
} from "../src/shared/fleet.js";

function fixture() {
  const a = generateMachineKey(),
    b = generateMachineKey(),
    c = generateMachineKey();
  const document: FleetDirectory = {
    version: 1,
    fleetId: randomUUID(),
    epoch: 0,
    revision: 0,
    mutationId: randomUUID(),
    parent: null,
    kind: "genesis",
    controller: a.identity,
    members: [a, b].map((key, i) => ({
      ...key.identity,
      grantId: randomUUID(),
      name: "Same display name",
      origin: `https://machine-${i}.example`,
    })),
    tombstones: [],
  };
  const signed = (
    doc: FleetDirectory,
    key = a.privateKey,
  ): SignedFleetDirectory => ({
    document: doc,
    signature: signDirectory(doc, key),
    acceptance: null,
  });
  const next = (changes: Partial<FleetDirectory> = {}): FleetDirectory => ({
    ...document,
    kind: "revision",
    parent: directoryDigest(document),
    revision: 1,
    mutationId: randomUUID(),
    ...changes,
  });
  return { a, b, c, document, signed, next };
}

it("verifies roots and key-continuous endpoint repairs independently of display names", () => {
  const { document, signed, next } = fixture();
  expect(verifyDirectoryRoot(signed(document))).toEqual(signed(document));
  const updated = next({
    members: document.members.map((m, i) =>
      i ? { ...m, origin: "https://new.example" } : m,
    ),
  });
  expect(verifyDirectorySuccessor(signed(updated), document).document).toEqual(
    updated,
  );
  expect(
    directoryDigest({
      ...document,
      controller: {
        publicKey: document.controller.publicKey,
        machineId: document.controller.machineId,
      },
    }),
  ).toBe(directoryDigest(document));
});

it.each([
  "parent",
  "epoch",
  "revision",
  "fleet",
  "controller",
  "key",
  "signature",
  "mutation",
  "grant",
])("refuses a changed %s at the directory verification boundary", (field) => {
  const { document, signed, next, b, c } = fixture();
  const value = next();
  if (field === "parent") value.parent = "a".repeat(64);
  if (field === "epoch") value.epoch = 99;
  if (field === "revision") value.revision = 3;
  if (field === "fleet") value.fleetId = randomUUID();
  if (field === "controller") value.controller = b.identity;
  if (field === "key")
    value.members = value.members.map((m, i) =>
      i ? { ...m, publicKey: c.identity.publicKey } : m,
    );
  if (field === "mutation") value.mutationId = document.mutationId;
  if (field === "grant")
    value.members = value.members.map((m, i) =>
      i ? { ...m, grantId: randomUUID() } : m,
    );
  expect(() =>
    verifyDirectorySuccessor(
      signed(value, field === "signature" ? c.privateKey : undefined),
      document,
    ),
  ).toThrow();
});

it("rejects edits after signing and malformed/oversized protocol envelopes", () => {
  const { document, signed, next } = fixture();
  const value = signed(next());
  value.document.members = value.document.members.map((m, i) =>
    i ? { ...m, origin: "https://attacker.example" } : m,
  );
  expect(() => verifyDirectorySuccessor(value, document)).toThrow("signature");
  expect(() =>
    validateDirectory({ ...signed(document), deviceCookie: "not allowed" }),
  ).toThrow();
  expect(() =>
    validateDirectory({
      ...signed(document),
      document: { ...document, version: 2 },
    }),
  ).toThrow();
  expect(() =>
    validateDirectory({
      ...signed(document),
      document: { ...document, members: Array(129).fill(document.members[0]) },
    }),
  ).toThrow();
});

it("rejects malformed signatures and alternate encodings of the same signature", () => {
  const { document, signed, next } = fixture();
  const envelope = signed(next());
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const alias =
    envelope.signature.slice(0, -1) +
    alphabet[alphabet.indexOf(envelope.signature.at(-1)!) + 1];
  expect(Buffer.from(alias, "base64url")).toEqual(
    Buffer.from(envelope.signature, "base64url"),
  );
  for (const signature of [
    alias,
    "!".repeat(86),
    "A".repeat(85),
    "A".repeat(86),
  ])
    expect(() =>
      verifyDirectorySuccessor({ ...envelope, signature }, document),
    ).toThrow();
});

it("retains tombstones, refuses controller removal and prevents removed-member resurrection", () => {
  const { document, signed, next } = fixture();
  const removed = next({
    members: [document.members[0]],
    tombstones: [document.members[1].machineId],
  });
  expect(verifyDirectorySuccessor(signed(removed), document).document).toEqual(
    removed,
  );
  expect(() =>
    verifyDirectorySuccessor(
      signed(next({ members: [document.members[0]] })),
      document,
    ),
  ).toThrow("lineage");
  expect(() =>
    verifyDirectorySuccessor(
      signed(
        next({
          members: [document.members[1]],
          tombstones: [document.controller.machineId],
        }),
      ),
      document,
    ),
  ).toThrow("controller");
  const resurrected = {
    ...next(),
    parent: directoryDigest(removed),
    revision: 2,
  };
  expect(() => verifyDirectorySuccessor(signed(resurrected), removed)).toThrow(
    "lineage",
  );
});

it("refuses duplicate machine, destination grant, or endpoint claims", () => {
  const { document, signed } = fixture();
  for (const field of ["machine", "grant", "origin"] as const) {
    const member =
      field === "machine"
        ? document.members[0]
        : {
            ...document.members[1],
            ...(field === "grant"
              ? { grantId: document.members[0].grantId }
              : { origin: document.members[0].origin }),
          };
    expect(() =>
      validateDirectory(
        signed({ ...document, members: [document.members[0], member] }),
      ),
    ).toThrow("Conflicting");
  }
});

it("requires both controllers to sign the same handoff without granting other changes", () => {
  const { a, b, c, document, signed, next } = fixture();
  const handoff = next({
    kind: "handoff",
    epoch: 1,
    revision: 0,
    controller: b.identity,
  });
  const envelope = {
    ...signed(handoff),
    acceptance: signDirectory(handoff, b.privateKey, "handoff"),
  };
  expect(
    verifyDirectorySuccessor(envelope, document).document.controller,
  ).toEqual(b.identity);
  for (const invalid of [
    { ...envelope, signature: signDirectory(handoff, b.privateKey) },
    {
      ...envelope,
      acceptance: signDirectory(handoff, a.privateKey, "handoff"),
    },
    { ...envelope, acceptance: signDirectory(handoff, b.privateKey) },
    { ...envelope, acceptance: null },
  ])
    expect(() => verifyDirectorySuccessor(invalid, document)).toThrow();
  const unrelated = {
    ...handoff,
    controller: c.identity,
    members: [
      ...handoff.members,
      {
        ...c.identity,
        grantId: randomUUID(),
        name: "C",
        origin: "https://c.example",
      },
    ],
  };
  expect(() =>
    verifyDirectorySuccessor(
      {
        ...signed(unrelated),
        acceptance: signDirectory(unrelated, c.privateKey, "handoff"),
      },
      document,
    ),
  ).toThrow("handoff");
  const oldWriter = {
    ...handoff,
    kind: "revision" as const,
    revision: 1,
    parent: directoryDigest(handoff),
    mutationId: randomUUID(),
  };
  expect(() => verifyDirectorySuccessor(signed(oldWriter), handoff)).toThrow(
    "signature",
  );
  expect(
    verifyDirectorySuccessor(signed(oldWriter, b.privateKey), handoff).document,
  ).toEqual(oldWriter);
});

it("never admits self-signed recovery as a successor of trusted history", () => {
  const { b, document, signed, next } = fixture();
  const reset = next({
    kind: "recovery",
    epoch: 1,
    revision: 0,
    controller: b.identity,
  });
  const root = signed(reset, b.privateKey);
  expect(verifyDirectoryRoot(root).document).toEqual(reset);
  expect(() => verifyDirectorySuccessor(root, document)).toThrow(
    "explicit local consent",
  );
});

it("rejects URL capabilities and does not negotiate administrative operations", () => {
  for (const origin of [
    "http://example.com",
    "https://example.com/",
    "https://example.com/path",
    "https://user:pass@example.com",
    "https://example.com?token=x",
    "https://example.com#token",
  ])
    expect(FleetOrigin.safeParse(origin).success).toBe(false);
  expect(FleetOrigin.parse("https://example.com")).toBe("https://example.com");
  expect(FleetCapabilities.parse([])).toEqual([]);
  expect(FleetCapabilities.safeParse(["read", "directory-admin"]).success).toBe(
    false,
  );
  expect(FleetCapabilities.safeParse(["read", "read"]).success).toBe(false);
});
