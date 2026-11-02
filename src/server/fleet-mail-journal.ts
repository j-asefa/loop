import * as deploymentProfileQueries from "./sql/deployment-profile.js";
import * as fleetMailOutboxQueries from "./sql/fleet-mail-outbox.js";
import * as fleetMailInboxQueries from "./sql/fleet-mail-inbox.js";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  FLEET_MAIL_PENDING,
  FLEET_MAIL_PEER_PENDING,
  FLEET_MAIL_PREPARE_MS,
  FleetMailAdmission,
  FleetMailEnvelope,
  FleetMailReceipt,
  FleetMailReceiptAdmission,
  FleetMailReference,
  FleetMailOffer,
  FleetMailRefusal,
  fleetMailSettled,
} from "../shared/fleet-mail.js";
import { FleetGrantContext } from "../shared/fleet.js";
import { Problem } from "../shared/problem.js";
import { directoryDigest, fleetPayloadDigest } from "./fleet-crypto.js";
import type { FleetAuthority } from "./fleet-authority.js";

type Pins = {
  peer_id: string;
  fleet_id: string;
  source_grant_id: string;
  destination_grant_id: string;
  payload_digest: string;
};
type Outgoing = Pins & {
  message_id: string;
  envelope: string | null;
  state: "pending" | "unknown" | "accepted" | "refused";
  receipt: string | null;
  local_refusal: string | null;
  settled: number;
};
type Incoming = Pins & {
  message_id: string;
  admission: string;
  revision: number;
};
const unavailable = () =>
  new Problem(403, "The original mail grant is unavailable.");
const conflict = () =>
  new Problem(409, "Mail identity belongs to different input or bindings.");

/** The owning mail service supplies synchronous policy/queue callbacks inside
 * these transactions. They must not call a provider or perform network IO. No
 * method fabricates a local agent for a remote participant. This journal alone
 * does not enable peer mail or grant a file/context read. */
export class FleetMailJournal {
  constructor(
    private readonly db: Database.Database,
    private readonly authority: FleetAuthority,
    private readonly owner: string,
    private readonly clock: () => number = Date.now,
  ) {}

  private profile() {
    if (
      (
        deploymentProfileQueries.current(this.db) as
          { profile: string } | undefined
      )?.profile !== "companion"
    )
      throw unavailable();
  }
  private pins(pins: Pins, incoming: boolean) {
    this.profile();
    const document = this.authority.directory(this.owner)?.document;
    const local = document?.members.find(
      (member) => member.machineId === this.authority.identity.machineId,
    );
    const peer = document?.members.find(
      (member) => member.machineId === pins.peer_id,
    );
    if (
      !document ||
      !local ||
      !peer ||
      peer.machineId === local.machineId ||
      document.fleetId !== pins.fleet_id ||
      local.grantId !==
        (incoming ? pins.destination_grant_id : pins.source_grant_id) ||
      peer.grantId !==
        (incoming ? pins.source_grant_id : pins.destination_grant_id)
    )
      throw unavailable();
    this.authority.acceptedGrant(
      this.owner,
      peer.machineId,
      document.fleetId,
      local.grantId,
      "mail",
    );
    return document;
  }
  private outgoingRow(messageId: string) {
    z.string().uuid().parse(messageId);
    return fleetMailOutboxQueries.get(this.db, this.owner, messageId) as
      Outgoing | undefined;
  }
  outgoing(messageId: string) {
    const row = this.outgoingRow(messageId);
    if (!row) return null;
    return {
      messageId,
      peer: row.peer_id,
      payloadDigest: row.payload_digest,
      state: row.state,
      settled: row.settled === 1,
      localRefusal: row.local_refusal
        ? FleetMailRefusal.parse(row.local_refusal)
        : null,
      receipt: row.receipt
        ? FleetMailReceipt.parse(JSON.parse(row.receipt))
        : null,
    };
  }
  unsettled(time = this.clock()) {
    return (
      fleetMailOutboxQueries.due(
        this.db,
        this.owner,
        time,
        FLEET_MAIL_PENDING,
      ) as { message_id: string }[]
    ).map((row) => row.message_id);
  }
  wake() {
    fleetMailOutboxQueries.restart(this.db, this.owner);
  }
  defer(messageId: string, failed: boolean, time = this.clock()) {
    const row = fleetMailOutboxQueries.attempts(
      this.db,
      this.owner,
      messageId,
    ) as { attempts: number } | undefined;
    if (!row) return;
    const attempts = failed ? row.attempts + 1 : 0;
    fleetMailOutboxQueries.retry(
      this.db,
      attempts,
      time +
        Math.min(300_000, 15_000 * 2 ** Math.min(Math.max(attempts - 1, 0), 5)),
      this.owner,
      messageId,
    );
  }
  /** Only the sending machine's internal drainer may obtain an unsent body.
   * Unknown/accepted identities cannot supply a replayable envelope. */
  pendingEnvelope(messageId: string) {
    const row = this.outgoingRow(messageId);
    if (!row || row.state !== "pending" || row.envelope === null) return null;
    this.pins(row, false);
    return FleetMailEnvelope.parse(JSON.parse(row.envelope));
  }
  /** Only a verified prepared receipt can expose an uncertain body to the
   * transport. The caller must obtain that receipt afresh before each retry. */
  preparedEnvelope(messageId: string, reservationId: string) {
    const row = this.outgoingRow(messageId);
    if (!row || row.settled || !row.envelope || !row.receipt) return null;
    const receipt = FleetMailReceipt.parse(JSON.parse(row.receipt));
    if (
      receipt.admission.state !== "prepared" ||
      receipt.admission.reservationId !== reservationId
    )
      return null;
    this.pins(row, false);
    return FleetMailEnvelope.parse(JSON.parse(row.envelope));
  }

  beginPreparedTransmission(
    messageId: string,
    reservationId: string,
    authorizeSender: (envelope: FleetMailEnvelope) => void,
  ) {
    return this.db
      .transaction(() => {
        const envelope = this.preparedEnvelope(messageId, reservationId);
        if (!envelope) return null;
        authorizeSender(structuredClone(envelope));
        this.pins(this.outgoingRow(messageId)!, false);
        // Consume the observed preparation before IO. Restart must ask the
        // destination again; this cached observation cannot authorize a replay.
        fleetMailOutboxQueries.clearReceipt(
          this.db,
          this.clock(),
          this.clock(),
          this.owner,
          messageId,
        );
        return envelope;
      })
      .immediate();
  }
  enqueue(
    input: unknown,
    authorizeSender: (envelope: FleetMailEnvelope) => void,
  ) {
    const envelope = FleetMailEnvelope.parse(input);
    const digest = fleetPayloadDigest(envelope);
    return this.db
      .transaction(() => {
        if (envelope.source.machineId !== this.authority.identity.machineId)
          throw unavailable();
        const existing = this.outgoingRow(envelope.messageId);
        if (existing) {
          if (existing.payload_digest !== digest) throw conflict();
          return this.outgoing(envelope.messageId)!;
        }
        const pins: Pins = {
          peer_id: envelope.destination.machineId,
          fleet_id: envelope.authority.fleetId,
          source_grant_id: envelope.authority.sourceGrantId,
          destination_grant_id: envelope.authority.destinationGrantId,
          payload_digest: digest,
        };
        if (
          directoryDigest(this.pins(pins, false)) !==
          envelope.authority.directory
        )
          throw unavailable();
        authorizeSender(structuredClone(envelope));
        this.pins(pins, false);
        if (
          (
            fleetMailOutboxQueries.pendingCount(this.db, this.owner) as {
              n: number;
            }
          ).n >= FLEET_MAIL_PENDING
        )
          throw new Problem(
            429,
            "This workspace has too much pending fleet mail.",
          );
        const now = Date.now();
        fleetMailOutboxQueries.insert(
          this.db,
          this.owner,
          envelope.messageId,
          pins.peer_id,
          pins.fleet_id,
          pins.source_grant_id,
          pins.destination_grant_id,
          digest,
          JSON.stringify(envelope),
          now,
          now,
        );
        return this.outgoing(envelope.messageId)!;
      })
      .immediate();
  }

  /** Commit uncertainty before the first envelope transmission. On restart or
   * an ambiguous response, the caller may query this identity's receipt only. */
  beginTransmission(
    messageId: string,
    authorizeSender: (envelope: FleetMailEnvelope) => void,
  ) {
    return this.db
      .transaction(() => {
        const row = this.outgoingRow(messageId);
        if (!row || row.state !== "pending") return null;
        this.pins(row, false);
        const envelope = FleetMailEnvelope.parse(JSON.parse(row.envelope!));
        authorizeSender(structuredClone(envelope));
        this.pins(row, false);
        const now = Date.now();
        fleetMailOutboxQueries.markTransmitted(
          this.db,
          now,
          now,
          this.owner,
          messageId,
        );
        return envelope;
      })
      .immediate();
  }

  /** Local policy can retire work only while no envelope could have left this
   * machine. Unknown/accepted work retains its honest destination outcome. */
  refuseUnsent(messageId: string, reason: z.infer<typeof FleetMailRefusal>) {
    z.string().uuid().parse(messageId);
    FleetMailRefusal.parse(reason);
    return (
      fleetMailOutboxQueries.refusePending(
        this.db,
        reason,
        Date.now(),
        this.owner,
        messageId,
      ).changes === 1
    );
  }

  recordReceipt(messageId: string, input: unknown) {
    const receipt = FleetMailReceipt.parse(input);
    return this.db
      .transaction(() => {
        const row = this.outgoingRow(messageId);
        if (
          !row ||
          row.local_refusal !== null ||
          (row.state === "pending" && receipt.admission.state === "accepted")
        )
          throw conflict();
        this.pins(row, false);
        if (
          receipt.messageId !== messageId ||
          receipt.source !== this.authority.identity.machineId ||
          receipt.destination !== row.peer_id ||
          receipt.payloadDigest !== row.payload_digest
        )
          throw conflict();
        const previous = row.receipt
          ? FleetMailReceipt.parse(JSON.parse(row.receipt))
          : undefined;
        if (previous) {
          if (receipt.revision < previous.revision)
            return this.outgoing(messageId)!;
          if (receipt.revision === previous.revision) {
            if (fleetPayloadDigest(receipt) !== fleetPayloadDigest(previous))
              throw conflict();
            return this.outgoing(messageId)!;
          }
          this.sameBinding(previous.admission, receipt.admission);
        }
        const settled = fleetMailSettled(receipt.admission);
        fleetMailOutboxQueries.receipt(
          this.db,
          receipt.admission.state === "prepared"
            ? row.state
            : receipt.admission.state,
          JSON.stringify(receipt),
          settled ? 1 : 0,
          settled ? 1 : 0,
          Date.now(),
          this.owner,
          messageId,
        );
        return this.outgoing(messageId)!;
      })
      .immediate();
  }
  private sameBinding(
    previous: FleetMailReceiptAdmission,
    next: FleetMailReceiptAdmission,
  ) {
    if (
      (fleetMailSettled(previous) && !fleetMailSettled(next)) ||
      (previous.state !== "prepared" && previous.state !== next.state) ||
      (previous.state === "prepared" &&
        next.state === "prepared" &&
        (previous.reservationId !== next.reservationId ||
          previous.expiresAt !== next.expiresAt)) ||
      (previous.state === "accepted" &&
        next.state === "accepted" &&
        (previous.mailId !== next.mailId ||
          previous.threadId !== next.threadId ||
          (previous.conversationId !== null &&
            previous.conversationId !== next.conversationId))) ||
      (previous.state === "refused" &&
        next.state === "refused" &&
        previous.reason !== next.reason)
    )
      throw conflict();
  }
  private authorize(input: FleetGrantContext, peer: string) {
    this.profile();
    const context = FleetGrantContext.parse(input);
    const accepted = this.authority.authorize(context);
    if (
      context.operation !== "mail" ||
      context.peer !== peer ||
      accepted.owner !== this.owner
    )
      throw unavailable();
    return context;
  }
  private incomingRow(peer: string, messageId: string) {
    return fleetMailInboxQueries.get(this.db, this.owner, peer, messageId) as
      Incoming | undefined;
  }
  private incomingReceipt(row: Incoming): FleetMailReceipt {
    return {
      source: row.peer_id,
      destination: this.authority.identity.machineId,
      messageId: row.message_id,
      payloadDigest: row.payload_digest,
      revision: row.revision,
      admission: FleetMailReceiptAdmission.parse(JSON.parse(row.admission)),
    };
  }

  private expirePrepared(row: Incoming) {
    const admission = FleetMailReceiptAdmission.parse(
      JSON.parse(row.admission),
    );
    if (admission.state !== "prepared" || admission.expiresAt > this.clock())
      return row;
    fleetMailInboxQueries.settle(
      this.db,
      JSON.stringify({ state: "refused", reason: "expired" }),
      this.clock(),
      this.owner,
      row.peer_id,
      row.message_id,
    );
    return this.incomingRow(row.peer_id, row.message_id)!;
  }
  private refreshIncoming(
    row: Incoming,
    inspect: (admission: FleetMailAdmission) => FleetMailAdmission,
  ) {
    const previous = FleetMailReceiptAdmission.parse(JSON.parse(row.admission));
    if (previous.state !== "accepted") return row;
    const next = FleetMailAdmission.parse(inspect(structuredClone(previous)));
    this.sameBinding(previous, next);
    if (fleetPayloadDigest(previous) === fleetPayloadDigest(next)) return row;
    fleetMailInboxQueries.admission(
      this.db,
      JSON.stringify(next),
      fleetMailSettled(next) ? 1 : 0,
      this.clock(),
      this.owner,
      row.peer_id,
      row.message_id,
    );
    return this.incomingRow(row.peer_id, row.message_id)!;
  }
  private capacity(
    peer: string,
    inspect?: (admission: FleetMailAdmission) => FleetMailAdmission,
  ) {
    // At the quota, refresh bounded owner-local state without relying on a
    // sender's receipt poll or its continued grant. Identity tombstones remain;
    // inspection neither admits new mail nor dispatches native work.
    const pending = fleetMailInboxQueries.pending(
      this.db,
      this.owner,
      FLEET_MAIL_PENDING,
    ) as Incoming[];
    const atLimit =
      pending.length === FLEET_MAIL_PENDING ||
      pending.filter((row) => row.peer_id === peer).length >=
        FLEET_MAIL_PEER_PENDING;
    for (const row of pending) {
      const current = this.expirePrepared(row);
      if (inspect && atLimit) this.refreshIncoming(current, inspect);
    }
    if (!atLimit) return;
    const remaining = fleetMailInboxQueries.pendingCounts(
      this.db,
      peer,
      this.owner,
    ) as { n: number; peers: number };
    if (
      remaining.n >= FLEET_MAIL_PENDING ||
      remaining.peers >= FLEET_MAIL_PEER_PENDING
    )
      throw new Problem(429, "This workspace has too much pending fleet mail.");
  }

  /** Reserve an immutable identity without accepting content or queueing work.
   * Its signed prepared receipt proves that this identity is not yet admitted.
   * A later accept must present this reservation and use the same digest. */
  prepare(
    context: FleetGrantContext,
    input: unknown,
    inspect?: (admission: FleetMailAdmission) => FleetMailAdmission,
  ) {
    const offer = FleetMailOffer.parse(input);
    return this.db
      .transaction(() => {
        this.authorize(context, offer.source);
        if (offer.destination !== this.authority.identity.machineId)
          throw unavailable();
        const pins: Pins = {
          peer_id: offer.source,
          fleet_id: offer.authority.fleetId,
          source_grant_id: offer.authority.sourceGrantId,
          destination_grant_id: offer.authority.destinationGrantId,
          payload_digest: offer.payloadDigest,
        };
        this.pins(pins, true);
        const existing = this.incomingRow(offer.source, offer.messageId);
        if (existing) {
          this.pins(existing, true);
          if (
            existing.payload_digest !== offer.payloadDigest ||
            existing.fleet_id !== pins.fleet_id ||
            existing.source_grant_id !== pins.source_grant_id ||
            existing.destination_grant_id !== pins.destination_grant_id
          )
            throw conflict();
          return this.incomingReceipt(this.expirePrepared(existing));
        }
        this.capacity(offer.source, inspect);
        this.authorize(context, offer.source);
        this.pins(pins, true);
        const now = this.clock();
        const admission = {
          state: "prepared" as const,
          reservationId: randomUUID(),
          expiresAt: now + FLEET_MAIL_PREPARE_MS,
        };
        fleetMailInboxQueries.prepare(
          this.db,
          this.owner,
          pins.peer_id,
          offer.messageId,
          pins.fleet_id,
          pins.source_grant_id,
          pins.destination_grant_id,
          pins.payload_digest,
          JSON.stringify(admission),
          now,
          now,
        );
        return this.incomingReceipt(
          this.incomingRow(offer.source, offer.messageId)!,
        );
      })
      .immediate();
  }

  /** Bind private file staging to a current, unaccepted inbox reservation.
   * Synchronous writes commit with the checked owner, grants and payload. */
  withPrepared<T>(
    context: FleetGrantContext,
    input: unknown,
    reservationId: string,
    apply: (envelope: FleetMailEnvelope, expiresAt: number) => T,
  ): T {
    const envelope = FleetMailEnvelope.parse(input);
    return this.db
      .transaction(() => {
        this.authorize(context, envelope.source.machineId);
        if (
          envelope.destination.machineId !== this.authority.identity.machineId
        )
          throw unavailable();
        const found = this.incomingRow(
          envelope.source.machineId,
          envelope.messageId,
        );
        if (!found || found.payload_digest !== fleetPayloadDigest(envelope))
          throw conflict();
        this.pins(found, true);
        if (envelope.files.length)
          this.authority.acceptedGrant(
            this.owner,
            envelope.source.machineId,
            envelope.authority.fleetId,
            envelope.authority.destinationGrantId,
            "files",
          );
        if (
          found.fleet_id !== envelope.authority.fleetId ||
          found.source_grant_id !== envelope.authority.sourceGrantId ||
          found.destination_grant_id !== envelope.authority.destinationGrantId
        )
          throw conflict();
        const receipt = this.incomingReceipt(this.expirePrepared(found));
        if (
          receipt.admission.state !== "prepared" ||
          receipt.admission.reservationId !== reservationId
        )
          throw conflict();
        const result = apply(
          structuredClone(envelope),
          receipt.admission.expiresAt,
        );
        if (result && typeof (result as { then?: unknown }).then === "function")
          throw new Error(
            "Prepared mail work must finish inside its transaction",
          );
        return result;
      })
      .immediate();
  }

  /** The inbox identity and existing mail/run queue commit atomically. Throwing
   * or returning a Promise rolls both back; uncertain native work never enters
   * this callback and duplicate envelopes never invoke it again. */
  accept(
    context: FleetGrantContext,
    input: unknown,
    admit: (envelope: FleetMailEnvelope) => FleetMailAdmission,
    reservationId?: string,
    inspect?: (admission: FleetMailAdmission) => FleetMailAdmission,
  ) {
    const envelope = FleetMailEnvelope.parse(input);
    const digest = fleetPayloadDigest(envelope);
    return this.db
      .transaction(() => {
        this.authorize(context, envelope.source.machineId);
        if (
          envelope.destination.machineId !== this.authority.identity.machineId
        )
          throw unavailable();
        const pins: Pins = {
          peer_id: envelope.source.machineId,
          fleet_id: envelope.authority.fleetId,
          source_grant_id: envelope.authority.sourceGrantId,
          destination_grant_id: envelope.authority.destinationGrantId,
          payload_digest: digest,
        };
        this.pins(pins, true);
        let existing = this.incomingRow(pins.peer_id, envelope.messageId);
        if (existing) {
          if (existing.payload_digest !== digest) throw conflict();
          this.pins(existing, true);
          existing = this.expirePrepared(existing);
          const preparation = this.incomingReceipt(existing).admission;
          if (preparation.state !== "prepared")
            return this.incomingReceipt(existing);
          if (preparation.reservationId !== reservationId) throw conflict();
        }
        if (!existing) {
          // Missing/expired transport receipts never grant a fresh admission.
          // Direct internal callers retain the original journal primitive.
          if (reservationId !== undefined) throw conflict();
          this.capacity(pins.peer_id, inspect);
        }
        const admission = FleetMailAdmission.parse(
          admit(structuredClone(envelope)),
        );
        this.authorize(context, envelope.source.machineId);
        this.pins(pins, true);
        const now = this.clock();
        if (existing) {
          fleetMailInboxQueries.admission(
            this.db,
            JSON.stringify(admission),
            fleetMailSettled(admission) ? 1 : 0,
            now,
            this.owner,
            pins.peer_id,
            envelope.messageId,
          );
          return this.incomingReceipt(
            this.incomingRow(pins.peer_id, envelope.messageId)!,
          );
        }
        fleetMailInboxQueries.insert(
          this.db,
          this.owner,
          pins.peer_id,
          envelope.messageId,
          pins.fleet_id,
          pins.source_grant_id,
          pins.destination_grant_id,
          digest,
          JSON.stringify(admission),
          fleetMailSettled(admission) ? 1 : 0,
          now,
          now,
        );
        return this.incomingReceipt(
          this.incomingRow(pins.peer_id, envelope.messageId)!,
        );
      })
      .immediate();
  }

  /** A missing row is unknown, never permission to submit a replacement. Read
   * the original local mail row to advance delivery status without dispatch. */
  receipt(
    context: FleetGrantContext,
    input: unknown,
    inspect: (admission: FleetMailAdmission) => FleetMailAdmission,
  ) {
    const reference = FleetMailReference.parse(input);
    return this.db
      .transaction(() => {
        this.authorize(context, reference.source);
        let row = this.incomingRow(reference.source, reference.messageId);
        if (!row) return null;
        this.pins(row, true);
        if (row.payload_digest !== reference.payloadDigest) throw conflict();
        row = this.expirePrepared(row);
        return this.incomingReceipt(this.refreshIncoming(row, inspect));
      })
      .immediate();
  }
}
