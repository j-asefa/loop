import * as mailQueries from "./sql/agent-mail.js";
import type { FleetAuthority } from "./fleet-authority.js";
import type { FleetMailJournal } from "./fleet-mail-journal.js";
import type { FleetPeerMail } from "./fleet-peer-mail.js";
import { MailRefusal } from "./agent-mail-policy.js";
import { MailFileRefusal } from "./agent-mail-files.js";
import { Problem } from "../shared/problem.js";
import { db } from "./db.js";
import {
  authorizeFleetMailSender,
  outgoingFleetMailFile,
  reconcileFleetMail,
  recoverFleetMailProjections,
} from "./fleet-mail-origin.js";

/** An optional owning-machine service. Its bounded, durable outbox progresses
 * without a browser; it never dispatches native prompts or creates a new ID. */
export class FleetMailDrainer {
  private stopped = false;
  private timer?: ReturnType<typeof setInterval>;
  private readonly active = new Map<string, AbortController>();
  private readonly stopObserving: () => void;
  constructor(
    authority: FleetAuthority,
    private readonly owner: string,
    private readonly journal: FleetMailJournal,
    private readonly peer: FleetPeerMail,
    private readonly clock: () => number = Date.now,
  ) {
    this.stopObserving = authority.observe(owner, () => {
      // A signed address repair can wake the original identities immediately.
      this.journal.wake();
      // Construction alone must not transmit before the owning gateway starts.
      if (this.timer) void this.drain();
    });
  }
  start() {
    if (this.stopped || this.timer) return;
    this.timer = setInterval(() => void this.drain(), 1000);
    this.timer.unref();
    void this.drain();
  }
  async drain() {
    if (this.stopped) return;
    recoverFleetMailProjections(this.owner);
    const tasks: Promise<void>[] = [];
    for (const messageId of this.journal.unsettled(this.clock())) {
      if (this.active.size >= 4) break;
      if (this.active.has(messageId)) continue;
      const controller = new AbortController();
      this.active.set(messageId, controller);
      tasks.push(
        this.deliver(messageId, controller).finally(() =>
          this.active.delete(messageId),
        ),
      );
    }
    await Promise.allSettled(tasks);
  }
  private async deliver(messageId: string, controller: AbortController) {
    try {
      const pending = this.journal.pendingEnvelope(messageId);
      if (pending) authorizeFleetMailSender(this.owner, pending);
      await this.peer.deliver(
        messageId,
        (envelope) => authorizeFleetMailSender(this.owner, envelope),
        controller.signal,
        (envelope, fileId) =>
          outgoingFleetMailFile(this.owner, envelope, fileId),
      );
      if (this.stopped) return;
      reconcileFleetMail(this.owner, messageId);
      this.journal.defer(messageId, false, this.clock());
    } catch (error) {
      if (this.stopped) return;
      // Only an envelope that has never left may become a local refusal. An
      // uncertain/accepted effect still needs its original destination receipt.
      let refusal:
        | "sender_unavailable"
        | "files_unavailable"
        | "grant_revoked"
        | undefined;
      if (error instanceof MailFileRefusal) refusal = "files_unavailable";
      else if (error instanceof MailRefusal) refusal = "sender_unavailable";
      else if (error instanceof Problem && error.status === 403) {
        // A peer may be stale or reject an expired credential. Only locally
        // known grant invalidation can retire an unsent envelope permanently.
        try {
          this.journal.pendingEnvelope(messageId);
        } catch (local) {
          if (local instanceof Problem && local.status === 403)
            refusal = "grant_revoked";
        }
      }
      if (refusal) {
        this.journal.refuseUnsent(messageId, refusal);
        reconcileFleetMail(this.owner, messageId);
      }
      const stored = this.journal.outgoing(messageId);
      if (stored && !stored.settled) {
        const message =
          stored.state === "unknown"
            ? "Delivery is unconfirmed. Loop will check the original destination receipt."
            : error instanceof Problem && error.status === 403
              ? "The original peer grant is unavailable."
              : error instanceof Problem && error.status === 409
                ? "Waiting for the sending task or fleet directory to become available."
                : "The destination is unavailable. Retry or re-pair its changed address; this message keeps its original identity.";
        mailQueries.setOwnedError(db, message, this.owner, messageId);
      }
      this.journal.defer(messageId, true, this.clock());
    }
  }
  close() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    this.stopObserving();
    for (const controller of this.active.values()) controller.abort();
    this.peer.close();
  }
}
