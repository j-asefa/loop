import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import {
  FleetDirectory,
  MachineIdentity,
  MachinePublicKey,
  SignedFleetDirectory,
} from "../shared/fleet.js";
import { Problem } from "../shared/problem.js";

// All signing inputs are bounded, strict schemas. Sort object keys without
// sorting arrays: array order is part of the signed document.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function machineIdentity(publicKey: string): MachineIdentity {
  MachinePublicKey.parse(publicKey);
  const bytes = Buffer.from(publicKey, "base64url");
  const key = createPublicKey({ key: bytes, format: "der", type: "spki" });
  if (
    key.asymmetricKeyType !== "ed25519" ||
    key.export({ format: "der", type: "spki" }).toString("base64url") !==
      publicKey
  )
    throw new Problem(400, "Invalid fleet machine key.");
  return {
    machineId: `m_${createHash("sha256").update(bytes).digest("hex")}`,
    publicKey,
  };
}

export function generateMachineKey() {
  const keys = generateKeyPairSync("ed25519");
  return {
    identity: machineIdentity(
      keys.publicKey
        .export({ format: "der", type: "spki" })
        .toString("base64url"),
    ),
    privateKey: keys.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64url"),
  };
}

export function identityFromPrivateKey(privateKey: string) {
  return machineIdentity(
    createPublicKey(
      createPrivateKey({
        key: Buffer.from(privateKey, "base64url"),
        format: "der",
        type: "pkcs8",
      }),
    )
      .export({ format: "der", type: "spki" })
      .toString("base64url"),
  );
}

function bytes(document: FleetDirectory, purpose: "directory" | "handoff") {
  return Buffer.from(`loop:fleet:${purpose}:v1\n${canonical(document)}`);
}

export function directoryDigest(document: FleetDirectory): string {
  return createHash("sha256")
    .update(bytes(FleetDirectory.parse(document), "directory"))
    .digest("hex");
}

/** Server-only signing primitive; callers must durably fence authority first. */
export function signDirectory(
  input: FleetDirectory,
  privateKey: string,
  purpose: "directory" | "handoff" = "directory",
): string {
  return sign(
    null,
    bytes(FleetDirectory.parse(input), purpose),
    createPrivateKey({
      key: Buffer.from(privateKey, "base64url"),
      format: "der",
      type: "pkcs8",
    }),
  ).toString("base64url");
}

function signatureValid(
  document: FleetDirectory,
  signature: string,
  publicKey: string,
  purpose: "directory" | "handoff",
): boolean {
  return verify(
    null,
    bytes(document, purpose),
    createPublicKey({
      key: Buffer.from(publicKey, "base64url"),
      format: "der",
      type: "spki",
    }),
    Buffer.from(signature, "base64url"),
  );
}

export function validateDirectory(input: unknown): SignedFleetDirectory {
  const signed = SignedFleetDirectory.parse(input);
  const doc = signed.document;
  const ids = new Set<string>(),
    grants = new Set<string>(),
    origins = new Set<string>();
  for (const member of doc.members) {
    if (
      machineIdentity(member.publicKey).machineId !== member.machineId ||
      ids.has(member.machineId) ||
      grants.has(member.grantId) ||
      origins.has(member.origin)
    )
      throw new Problem(409, "Conflicting fleet machine identity or address.");
    ids.add(member.machineId);
    grants.add(member.grantId);
    origins.add(member.origin);
  }
  if (
    machineIdentity(doc.controller.publicKey).machineId !==
      doc.controller.machineId ||
    !ids.has(doc.controller.machineId) ||
    doc.tombstones.some((id) => ids.has(id)) ||
    new Set(doc.tombstones).size !== doc.tombstones.length
  )
    throw new Problem(409, "Invalid fleet controller or removal tombstones.");
  if ((doc.kind === "handoff") !== (signed.acceptance !== null))
    throw new Problem(400, "Invalid fleet controller acceptance.");
  return signed;
}

/** A trusted predecessor is required. A larger epoch never establishes trust.
 * Recovery is deliberately excluded: each destination must explicitly reset
 * its locally approved authority before admitting that new lineage. */
export function verifyDirectorySuccessor(
  input: unknown,
  previous: FleetDirectory,
): SignedFleetDirectory {
  const signed = validateDirectory(input),
    doc = signed.document;
  if (
    doc.fleetId !== previous.fleetId ||
    doc.parent !== directoryDigest(previous) ||
    doc.mutationId === previous.mutationId ||
    !previous.tombstones.every((id) => doc.tombstones.includes(id)) ||
    previous.members.some(
      (member) =>
        !doc.members.some((next) => next.machineId === member.machineId) &&
        !doc.tombstones.includes(member.machineId),
    ) ||
    doc.members.some((member) => {
      const old = previous.members.find(
        (m) => m.machineId === member.machineId,
      );
      return old && old.grantId !== member.grantId;
    })
  )
    throw new Problem(409, "Fleet directory lineage conflict.");
  if (doc.kind === "revision") {
    if (
      doc.epoch !== previous.epoch ||
      doc.revision !== previous.revision + 1 ||
      doc.controller.machineId !== previous.controller.machineId
    )
      throw new Problem(409, "Fleet directory authority conflict.");
  } else if (doc.kind === "handoff") {
    if (
      doc.epoch !== previous.epoch + 1 ||
      doc.revision !== 0 ||
      doc.controller.machineId === previous.controller.machineId ||
      !previous.members.some((m) => m.machineId === doc.controller.machineId) ||
      canonical(doc.members) !== canonical(previous.members) ||
      canonical(doc.tombstones) !== canonical(previous.tombstones) ||
      !signatureValid(
        doc,
        signed.acceptance!,
        doc.controller.publicKey,
        "handoff",
      )
    )
      throw new Problem(409, "Invalid fleet controller handoff.");
  } else {
    throw new Problem(409, "Fleet recovery requires explicit local consent.");
  }
  if (
    !signatureValid(
      doc,
      signed.signature,
      previous.controller.publicKey,
      "directory",
    )
  )
    throw new Problem(403, "Invalid fleet directory signature.");
  return signed;
}

/** Only call after obtaining local consent bound to this exact digest/key.
 * A valid self-signature alone does not authorize enrollment or recovery. */
export function verifyDirectoryRoot(input: unknown): SignedFleetDirectory {
  const signed = validateDirectory(input),
    doc = signed.document;
  if (
    !["genesis", "recovery"].includes(doc.kind) ||
    doc.revision !== 0 ||
    (doc.kind === "genesis"
      ? doc.parent !== null || doc.epoch !== 0
      : doc.parent === null || doc.epoch < 1) ||
    !signatureValid(
      doc,
      signed.signature,
      doc.controller.publicKey,
      "directory",
    )
  )
    throw new Problem(403, "Invalid fleet directory root.");
  return signed;
}
