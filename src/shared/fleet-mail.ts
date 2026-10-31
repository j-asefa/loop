import { z } from "zod";
import { FleetDigest, MachineId } from "./fleet.js";
import { MailStatusSchema } from "./agent-mail.js";
import { MAX_UPLOAD_BYTES } from "./uploads.js";

const Id = z.string().uuid();
const Counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const FLEET_MAIL_BYTES = 64 * 1024;
export const FLEET_MAIL_MAX_FILES = 8;
export const FLEET_MAIL_PENDING = 100;
export const FLEET_MAIL_PEER_PENDING = FLEET_MAIL_PENDING / 2;
export const FLEET_MAIL_PREPARE_MS = 30 * 60 * 1000;

export const FleetMailAuthority = z.strictObject({
  fleetId: Id,
  sourceGrantId: Id,
  destinationGrantId: Id,
  directory: FleetDigest,
});

/** Machine identity, never a display label or a gateway's local agent row. */
export const FleetAgentReference = z.strictObject({
  machineId: MachineId,
  agentId: Id,
});
export type FleetAgentReference = z.infer<typeof FleetAgentReference>;
export function fleetAgentAddress(reference: FleetAgentReference) {
  const parsed = FleetAgentReference.parse(reference);
  return `peer:${parsed.machineId}:${parsed.agentId}`;
}
export function parseFleetAgentAddress(value: string) {
  if (!value.startsWith("peer:")) return undefined;
  const match = /^peer:(m_[a-f0-9]{64}):([^:]+)$/.exec(value);
  return FleetAgentReference.parse({
    machineId: match?.[1],
    agentId: match?.[2],
  });
}

// These identify an authorized publication or verified local copy. They are
// not arbitrary URLs, paths, provider handles or grants to all owner artifacts.
export const FleetMailFile = z.strictObject({
  source: MachineId,
  fileId: Id,
  digest: FleetDigest,
  bytes: z.number().int().nonnegative().max(MAX_UPLOAD_BYTES),
  name: z
    .string()
    .min(1)
    .max(240)
    .regex(/^[^/\\\u0000-\u001f]+$/),
  mediaType: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[\x20-\x7e]+$/),
});

export const FleetMailEnvelope = z
  .strictObject({
    version: z.literal(1),
    messageId: Id,
    source: FleetAgentReference,
    destination: FleetAgentReference,
    // Immutable audit context. An address revision can change the head while
    // retaining both grants and this payload. Admission checks current grants.
    authority: FleetMailAuthority,
    sender: z.strictObject({
      name: z.string().min(1).max(200),
      runId: Id,
      conversationId: Id,
    }),
    thread: z.strictObject({
      origin: MachineId,
      id: Id,
      subject: z.string().min(1).max(120),
      recipientConversationId: Id.nullable(),
    }),
    body: z.string().min(1).max(12000),
    interrupt: z.boolean(),
    files: z.array(FleetMailFile).max(FLEET_MAIL_MAX_FILES),
  })
  .superRefine((value, context) => {
    if (
      value.source.machineId === value.destination.machineId ||
      ![value.source.machineId, value.destination.machineId].includes(
        value.thread.origin,
      ) ||
      value.files.some((file) => file.source !== value.source.machineId) ||
      new Set(value.files.map((file) => file.fileId)).size !==
        value.files.length
    )
      context.addIssue({
        code: "custom",
        message: "Invalid one-hop mail binding.",
      });
    if (
      new TextEncoder().encode(JSON.stringify(value)).length > FLEET_MAIL_BYTES
    )
      context.addIssue({
        code: "custom",
        message: "Fleet mail exceeds its byte limit.",
      });
  });
export type FleetMailEnvelope = z.infer<typeof FleetMailEnvelope>;

export const FleetMailReference = z.strictObject({
  source: MachineId,
  messageId: Id,
  payloadDigest: FleetDigest,
});
export type FleetMailReference = z.infer<typeof FleetMailReference>;
export const FleetMailOffer = FleetMailReference.extend({
  destination: MachineId,
  authority: FleetMailAuthority,
});
export type FleetMailOffer = z.infer<typeof FleetMailOffer>;
export const FleetMailRefusal = z.enum([
  "sender_unavailable",
  "recipient_unavailable",
  "thread_unavailable",
  "files_unavailable",
  "grant_revoked",
  "cancelled",
  "quota",
  "expired",
]);
export const FleetMailAdmission = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("accepted"),
    // IDs belong to the destination's existing mail and conversation tables.
    mailId: Id,
    threadId: Id,
    conversationId: Id.nullable(),
    status: MailStatusSchema,
  }),
  z.strictObject({ state: z.literal("refused"), reason: FleetMailRefusal }),
]);
export type FleetMailAdmission = z.infer<typeof FleetMailAdmission>;
export const FleetMailPreparation = z.strictObject({
  state: z.literal("prepared"),
  reservationId: Id,
  expiresAt: Counter.positive(),
});
export const FleetMailReceiptAdmission = z.discriminatedUnion("state", [
  ...FleetMailAdmission.options,
  FleetMailPreparation,
]);
export type FleetMailReceiptAdmission = z.infer<
  typeof FleetMailReceiptAdmission
>;
export const FleetMailReceipt = FleetMailReference.extend({
  destination: MachineId,
  revision: Counter.positive(),
  admission: FleetMailReceiptAdmission,
});
export type FleetMailReceipt = z.infer<typeof FleetMailReceipt>;

export function fleetMailSettled(admission: FleetMailReceiptAdmission) {
  return (
    admission.state === "refused" ||
    (admission.state === "accepted" &&
      [
        "not_delivered",
        "steered",
        "handled",
        "failed",
        "cancelled",
        "interrupted",
      ].includes(admission.status))
  );
}
