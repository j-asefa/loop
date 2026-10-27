import { z } from "zod";

export const FLEET_PROTOCOL_VERSION = 1;
export const FleetDigest = z.string().regex(/^[a-f0-9]{64}$/);
export const MachineId = z.string().regex(/^m_[a-f0-9]{64}$/);
// Ed25519 SPKI DER and signatures, encoded as unpadded base64url.
export const MachinePublicKey = z.string().regex(/^[A-Za-z0-9_-]{59}$/);
// A 64-byte signature leaves four zero padding bits in its last sextet.
// Require their canonical spelling even though Node's decoder accepts aliases.
export const FleetSignature = z.string().regex(/^[A-Za-z0-9_-]{85}[AQgw]$/);
export const MachineIdentity = z
  .object({ machineId: MachineId, publicKey: MachinePublicKey })
  .strict();
export type MachineIdentity = z.infer<typeof MachineIdentity>;

// Syntax only. Peer transport must additionally resolve and validate network
// addresses, forbid redirects, and prove possession of the enrolled key.
export const FleetOrigin = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.origin === value;
    } catch {
      return false;
    }
  }, "Use a canonical HTTPS origin without a path or credentials.");

export const FleetOperation = z.enum([
  "read",
  "act",
  "events",
  "mail",
  "files",
]);
export type FleetOperation = z.infer<typeof FleetOperation>;
// Directory administration, native bridges and distributed teams are never
// delegated operations. Missing capabilities grant no access.
export const FleetCapabilities = z
  .array(FleetOperation)
  .max(FleetOperation.options.length)
  .refine((values) => new Set(values).size === values.length);
export const FleetMember = MachineIdentity.extend({
  // Destination-issued identity of its locally approved owner/scope binding.
  // Local owner IDs are not comparable across installations.
  grantId: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  origin: FleetOrigin,
}).strict();
export type FleetMember = z.infer<typeof FleetMember>;

const Counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const FleetDirectory = z
  .object({
    version: z.literal(FLEET_PROTOCOL_VERSION),
    fleetId: z.string().uuid(),
    epoch: Counter,
    revision: Counter,
    mutationId: z.string().uuid(),
    parent: FleetDigest.nullable(),
    kind: z.enum(["genesis", "revision", "handoff", "recovery"]),
    controller: MachineIdentity,
    members: z.array(FleetMember).min(1).max(128),
    tombstones: z.array(MachineId).max(4096),
  })
  .strict();
export type FleetDirectory = z.infer<typeof FleetDirectory>;
export const SignedFleetDirectory = z
  .object({
    document: FleetDirectory,
    signature: FleetSignature,
    // The incoming controller proves possession over the same document. The
    // old controller's signature is still required for an ordinary handoff.
    acceptance: FleetSignature.nullable(),
  })
  .strict();
export type SignedFleetDirectory = z.infer<typeof SignedFleetDirectory>;

export const FleetAuthorityState = z.enum([
  "standalone",
  "controller",
  "handoff_pending",
  "replica",
  "removed",
  "recovery_pending",
  "incompatible",
]);

export function fleetSourceId(machineId: string): string {
  return `peer:${MachineId.parse(machineId)}`;
}
