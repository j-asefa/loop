import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { z } from "zod";
import { MachineId } from "../shared/fleet.js";
import { Problem } from "../shared/problem.js";
import { FleetAgentQuery, fleetMailApi } from "../shared/fleet-mail-api.js";
import type {
  FleetMailEnvelope,
  FleetMailReference,
} from "../shared/fleet-mail.js";
import type { FleetAuthority } from "./fleet-authority.js";
import type { FleetCredentialLeases } from "./fleet-credential-leases.js";
import type { FleetAccessLease } from "./fleet-credential-lease.js";
import type { FleetMailJournal } from "./fleet-mail-journal.js";
import type { FleetMailTransport } from "./fleet-mail-http.js";
import { verifyFleetDestination } from "./fleet-peer-identity.js";
import { verifyFleetProof } from "./fleet-proof.js";
import { directoryDigest, fleetPayloadDigest } from "./fleet-crypto.js";
import { FLEET_MAIL_FILE_CHUNK_BYTES } from "../shared/fleet-mail-files.js";

const unavailable = () =>
  new Problem(
    503,
    "This machine is unreachable. Retry or re-pair its changed address.",
  );
/** One-hop, owner-bound mail transport. The gateway process owns its shared
 * tunnel budget; an agent's tool persists work in the journal before this
 * drainer runs. Browsers and native harness processes carry no peer tokens. */
export class FleetPeerMail {
  private stopped = false;
  private readonly sending = new Set<string>();
  private readonly pending = new Map<AbortController, string>();
  private readonly stopObserving: () => void;
  constructor(
    private readonly authority: FleetAuthority,
    private readonly leases: FleetCredentialLeases,
    private readonly owner: string,
    private readonly journal: FleetMailJournal,
    private readonly transport: FleetMailTransport,
    private readonly clock: () => number = () => performance.now(),
  ) {
    this.stopObserving = authority.observe(owner, () => {
      for (const controller of this.pending.keys()) controller.abort();
    });
  }
  private target(peer: string) {
    MachineId.parse(peer);
    const status = this.authority.status(this.owner),
      document = status.directory?.document;
    const member = document?.members.find((m) => m.machineId === peer);
    const local = document?.members.find(
      (m) => m.machineId === this.authority.identity.machineId,
    );
    if (
      this.stopped ||
      !document ||
      !member ||
      !local ||
      status.state === "removed" ||
      peer === local.machineId
    )
      throw new Problem(
        403,
        "This machine is not an authorized mail destination.",
      );
    this.authority.acceptedGrant(
      this.owner,
      peer,
      document.fleetId,
      local.grantId,
      "mail",
    );
    return { member, head: directoryDigest(document) };
  }
  private async perform<T>(
    peer: string,
    signal: AbortSignal | undefined,
    current: () => void,
    invoke: (
      target: ReturnType<FleetPeerMail["target"]>,
      credential: FleetAccessLease,
      signal: AbortSignal,
      live: () => void,
    ) => Promise<T>,
  ) {
    current();
    const target = this.target(peer);
    if (
      this.pending.size >= 8 ||
      [...this.pending.values()].filter((id) => id === peer).length >= 2
    )
      throw new Problem(
        503,
        "Fleet mail transport is busy. Work remains on its owning machine.",
      );
    const controller = new AbortController();
    const lifetime = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(20_000),
      ...(signal ? [signal] : []),
    ]);
    this.pending.set(controller, peer);
    let credential: FleetAccessLease | undefined;
    const live = () => {
      current();
      if (lifetime.aborted) throw unavailable();
      if (credential && this.clock() >= credential.expiresAtMonotonic)
        throw new Problem(
          503,
          "Peer authentication expired before mail transport completed.",
        );
      if (this.target(peer).head !== target.head)
        throw new Problem(
          409,
          "The fleet directory changed during mail transport.",
        );
    };
    let rejectAbort!: () => void;
    const stopped = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(unavailable());
      lifetime.addEventListener("abort", rejectAbort, { once: true });
    });
    try {
      live();
      await Promise.race([
        verifyFleetDestination(target.member, this.transport, lifetime),
        stopped,
      ]);
      live();
      credential = await Promise.race([this.leases.get(peer, "mail"), stopped]);
      live();
      const result = await Promise.race([
        invoke(target, credential, lifetime, live),
        stopped,
      ]);
      live();
      return result;
    } catch (error) {
      if (error instanceof Problem && error.status === 403 && credential)
        this.leases.rejected(peer, "mail", credential.token);
      if (error instanceof Problem && error.status === 409)
        this.leases.refreshDirectory();
      throw error;
    } finally {
      lifetime.removeEventListener("abort", rejectAbort);
      this.pending.delete(controller);
    }
  }
  private verify(
    response: {
      requestId: string;
      requestDigest: string;
      machineId: string;
      peer: string;
      grantId: string;
      directory: string;
    },
    signature: string,
    target: ReturnType<FleetPeerMail["target"]>,
    purpose: "mail-directory" | "mail-delivery" | "mail-file",
    requestId: string,
    requestDigest: string,
  ) {
    if (
      response.requestId !== requestId ||
      response.requestDigest !== requestDigest ||
      response.machineId !== target.member.machineId ||
      response.peer !== this.authority.identity.machineId ||
      response.grantId !== target.member.grantId ||
      !verifyFleetProof(
        {
          machineId: target.member.machineId,
          publicKey: target.member.publicKey,
        },
        purpose,
        response,
        signature,
      )
    )
      throw new Problem(
        502,
        "The machine's mail response could not be verified.",
      );
    if (response.directory !== target.head)
      throw new Problem(
        409,
        "Synchronize the fleet directory before reading this mail response.",
      );
  }
  directory(
    peer: string,
    input: z.input<typeof FleetAgentQuery>,
    current: () => void,
    signal?: AbortSignal,
  ) {
    const query = FleetAgentQuery.parse(input);
    return this.perform(
      peer,
      signal,
      current,
      async (target, credential, lifetime, live) => {
        const request = {
          version: 1 as const,
          requestId: randomUUID(),
          credential: credential.token,
          query,
        };
        const raw = await this.transport.directory(
          target.member.origin,
          request,
          lifetime,
        );
        live();
        const parsed = fleetMailApi.directory.response.safeParse(raw);
        if (!parsed.success)
          throw new Problem(
            502,
            "The machine returned an incompatible agent directory.",
          );
        this.verify(
          parsed.data.response,
          parsed.data.signature,
          target,
          "mail-directory",
          request.requestId,
          fleetPayloadDigest({ requestId: request.requestId, query }),
        );
        return parsed.data.response.page;
      },
    );
  }

  /** Reconcile an uncertain send first. Only a fresh signed preparation can
   * authorize the same envelope again through the destination inbox. Missing
   * receipts stay unknown; accepted work never re-enters the queue callback. */
  deliver(
    messageId: string,
    authorizeSender: (envelope: FleetMailEnvelope) => void,
    signal?: AbortSignal,
    readFile?: (envelope: FleetMailEnvelope, fileId: string) => Buffer,
  ) {
    const stored = this.journal.outgoing(messageId);
    if (!stored) throw new Problem(404, "Outgoing mail was not found.");
    if (stored.settled)
      return Promise.resolve({
        delivery: stored,
        receiptAvailable: stored.receipt !== null,
      });
    if (this.sending.has(messageId))
      throw new Problem(503, "This message is already being reconciled.");
    this.sending.add(messageId);
    return this.perform(
      stored.peer,
      signal,
      () => {},
      async (target, credential, lifetime, live) => {
        const observe = (
          method: "prepare" | "receipt" | "accept",
          requestId: string,
          payload: object,
          raw: unknown,
        ) => {
          live();
          const parsed = fleetMailApi.receipt.response.safeParse(raw);
          if (!parsed.success)
            throw new Problem(
              502,
              "The machine returned an incompatible mail receipt.",
            );
          this.verify(
            parsed.data.response,
            parsed.data.signature,
            target,
            "mail-delivery",
            requestId,
            fleetPayloadDigest({ requestId, ...payload }),
          );
          if (parsed.data.response.method !== method)
            throw new Problem(
              502,
              "The mail response does not match its requested operation.",
            );
          const receipt = parsed.data.response.receipt;
          return {
            delivery: receipt
              ? this.journal.recordReceipt(messageId, receipt)
              : this.journal.outgoing(messageId)!,
            receiptAvailable: receipt !== null,
          };
        };
        const pending = this.journal.pendingEnvelope(messageId);
        const requestId = randomUUID();
        let observed: ReturnType<typeof observe>;
        if (pending) {
          authorizeSender(structuredClone(pending));
          live();
          const offer = {
            source: pending.source.machineId,
            destination: pending.destination.machineId,
            messageId,
            payloadDigest: stored.payloadDigest,
            authority: pending.authority,
          };
          observed = observe(
            "prepare",
            requestId,
            { offer },
            await this.transport.prepare(
              target.member.origin,
              { version: 1, requestId, credential: credential.token, offer },
              lifetime,
            ),
          );
        } else {
          const reference: FleetMailReference = {
            source: this.authority.identity.machineId,
            messageId,
            payloadDigest: stored.payloadDigest,
          };
          observed = observe(
            "receipt",
            requestId,
            { reference },
            await this.transport.receipt(
              target.member.origin,
              {
                version: 1,
                requestId,
                credential: credential.token,
                reference,
              },
              lifetime,
            ),
          );
        }
        const preparation = observed.delivery.receipt?.admission;
        if (!observed.receiptAvailable || preparation?.state !== "prepared")
          return observed;
        const reservationId = preparation.reservationId;
        const envelope = this.journal.preparedEnvelope(
          messageId,
          reservationId,
        );
        if (!envelope)
          throw new Problem(
            409,
            "Mail preparation is no longer current. Reconcile its original receipt.",
          );
        const fileLive = () => {
          live();
          authorizeSender(structuredClone(envelope));
          if (envelope.files.length)
            this.authority.acceptedGrant(
              this.owner,
              stored.peer,
              envelope.authority.fleetId,
              envelope.authority.sourceGrantId,
              "files",
            );
        };
        if (envelope.files.length && (!readFile || !this.transport.file))
          throw new Problem(
            503,
            "This machine cannot transfer mail files yet.",
          );
        for (const file of envelope.files) {
          fileLive();
          const bytes = readFile!(structuredClone(envelope), file.fileId);
          if (bytes.length !== file.bytes)
            throw new Problem(409, "The original mail file changed.");
          let offset = 0;
          do {
            fileLive();
            const chunk = {
              envelope,
              reservationId,
              fileId: file.fileId,
              offset,
              base64: bytes
                .subarray(offset, offset + FLEET_MAIL_FILE_CHUNK_BYTES)
                .toString("base64"),
            };
            const chunkId = randomUUID();
            const raw = await this.transport.file!(
              target.member.origin,
              {
                version: 1,
                requestId: chunkId,
                credential: credential.token,
                ...chunk,
              },
              lifetime,
            );
            fileLive();
            const parsed = fleetMailApi.file.response.safeParse(raw);
            if (!parsed.success)
              throw new Problem(
                502,
                "The machine returned an incompatible mail file receipt.",
              );
            this.verify(
              parsed.data.response,
              parsed.data.signature,
              target,
              "mail-file",
              chunkId,
              fleetPayloadDigest({ requestId: chunkId, ...chunk }),
            );
            const next = parsed.data.response.nextOffset;
            if (next === null) break;
            if (
              next <= offset ||
              next >= file.bytes ||
              next % FLEET_MAIL_FILE_CHUNK_BYTES
            )
              throw new Problem(
                502,
                "The machine returned an invalid mail file position.",
              );
            offset = next;
          } while (offset < file.bytes);
        }
        const acceptId = randomUUID();
        const raw = await this.transport.accept(
          target.member.origin,
          {
            version: 1,
            requestId: acceptId,
            credential: credential.token,
            envelope,
            reservationId,
          },
          lifetime,
          () => {
            fileLive();
            const claimed = this.journal.beginPreparedTransmission(
              messageId,
              reservationId,
              authorizeSender,
            );
            if (
              !claimed ||
              fleetPayloadDigest(claimed) !== stored.payloadDigest
            )
              throw new Problem(
                409,
                "Mail dispatch was already claimed. Reconcile its original receipt.",
              );
          },
        );
        return observe("accept", acceptId, { envelope, reservationId }, raw);
      },
    ).finally(() => this.sending.delete(messageId));
  }

  close() {
    if (this.stopped) return;
    this.stopped = true;
    this.stopObserving();
    for (const controller of this.pending.keys()) controller.abort();
  }
}
