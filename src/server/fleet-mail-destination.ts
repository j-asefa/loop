import type Database from "better-sqlite3";
import {
  FleetAgentPage,
  FleetMailDeliveryResponse,
  FleetMailDirectoryResponse,
  fleetMailApi,
  type FleetAgentQuery,
} from "../shared/fleet-mail-api.js";
import type {
  FleetMailAdmission,
  FleetMailEnvelope,
} from "../shared/fleet-mail.js";
import { Problem } from "../shared/problem.js";
import type { FleetAuthority } from "./fleet-authority.js";
import type { FleetCredentials } from "./fleet-credentials.js";
import { FleetMailJournal } from "./fleet-mail-journal.js";
import { FleetProof } from "./fleet-proof.js";
import { directoryDigest, fleetPayloadDigest } from "./fleet-crypto.js";

/** Trusted owning-policy callbacks, never a peer-selected owner, URL or route.
 * Directory projection excludes prompts and connection records. The admission
 * callback only writes the existing durable local mail/queue transaction. */
export type FleetMailHandlers = {
  directory(query: FleetAgentQuery): FleetAgentPage;
  admit(envelope: FleetMailEnvelope): FleetMailAdmission;
  inspect(admission: FleetMailAdmission): FleetMailAdmission;
};
export class FleetMailDestination {
  private readonly proof: FleetProof;
  private readonly journal: FleetMailJournal;
  private stopped = false;
  constructor(
    private readonly db: Database.Database,
    private readonly authority: FleetAuthority,
    private readonly credentials: FleetCredentials,
    private readonly owner: string,
    secrets: ConstructorParameters<typeof FleetProof>[2],
    private readonly handlers: FleetMailHandlers,
    clock?: () => number,
  ) {
    this.proof = new FleetProof(db, authority.identity, secrets);
    this.journal = new FleetMailJournal(db, authority, owner, clock);
  }
  private authorize(credential: string) {
    if (
      this.stopped ||
      (
        this.db
          .prepare("SELECT profile FROM deployment_profile WHERE singleton=1")
          .get() as { profile: string } | undefined
      )?.profile !== "companion"
    )
      throw new Problem(403, "Fleet mail is unavailable in this workspace.");
    const accepted = this.credentials.authenticate(credential);
    if (accepted.owner !== this.owner || accepted.context.operation !== "mail")
      throw new Problem(403, "This credential cannot use local agent mail.");
    const directory = this.authority.directory(this.owner);
    if (!directory)
      throw new Problem(403, "The fleet directory is unavailable.");
    return {
      context: accepted.context,
      directory: directoryDigest(directory.document),
    };
  }
  private identity(
    authorization: ReturnType<FleetMailDestination["authorize"]>,
    requestId: string,
    digest: string,
  ) {
    return {
      version: 1 as const,
      requestId,
      requestDigest: digest,
      machineId: this.authority.identity.machineId,
      peer: authorization.context.peer,
      grantId: authorization.context.grantId,
      directory: authorization.directory,
    };
  }
  directory(input: unknown) {
    const request = fleetMailApi.directory.body.parse(input);
    const authorized = this.authorize(request.credential);
    const page = FleetAgentPage.parse(this.handlers.directory(request.query));
    if (this.authorize(request.credential).directory !== authorized.directory)
      throw new Problem(409, "The fleet directory changed during discovery.");
    const response = FleetMailDirectoryResponse.parse({
      ...this.identity(
        authorized,
        request.requestId,
        fleetPayloadDigest({
          requestId: request.requestId,
          query: request.query,
        }),
      ),
      page,
    });
    return { response, signature: this.proof.sign("mail-directory", response) };
  }
  prepare(input: unknown) {
    const request = fleetMailApi.prepare.body.parse(input);
    const authorized = this.authorize(request.credential);
    const receipt = this.journal.prepare(
      authorized.context,
      request.offer,
      (admission) => this.handlers.inspect(admission),
    );
    if (this.authorize(request.credential).directory !== authorized.directory)
      throw new Problem(409, "The fleet directory changed during preparation.");
    const response = FleetMailDeliveryResponse.parse({
      ...this.identity(
        authorized,
        request.requestId,
        fleetPayloadDigest({
          requestId: request.requestId,
          offer: request.offer,
        }),
      ),
      method: "prepare",
      receipt,
    });
    return { response, signature: this.proof.sign("mail-delivery", response) };
  }
  accept(input: unknown) {
    const request = fleetMailApi.accept.body.parse(input);
    const authorized = this.authorize(request.credential);
    const receipt = this.journal.accept(
      authorized.context,
      request.envelope,
      (envelope) => this.handlers.admit(envelope),
      request.reservationId,
      (admission) => this.handlers.inspect(admission),
    );
    // A late authorization failure cannot undo acceptance. The sender keeps
    // its original identity and reconciles this durable receipt, never resends.
    if (this.authorize(request.credential).directory !== authorized.directory)
      throw new Problem(409, "The fleet directory changed during acceptance.");
    const response = FleetMailDeliveryResponse.parse({
      ...this.identity(
        authorized,
        request.requestId,
        fleetPayloadDigest({
          requestId: request.requestId,
          envelope: request.envelope,
          reservationId: request.reservationId,
        }),
      ),
      method: "accept",
      receipt,
    });
    return { response, signature: this.proof.sign("mail-delivery", response) };
  }
  receipt(input: unknown) {
    const request = fleetMailApi.receipt.body.parse(input);
    const authorized = this.authorize(request.credential);
    const receipt = this.journal.receipt(
      authorized.context,
      request.reference,
      (admission) => this.handlers.inspect(admission),
    );
    if (this.authorize(request.credential).directory !== authorized.directory)
      throw new Problem(
        409,
        "The fleet directory changed during receipt lookup.",
      );
    const response = FleetMailDeliveryResponse.parse({
      ...this.identity(
        authorized,
        request.requestId,
        fleetPayloadDigest({
          requestId: request.requestId,
          reference: request.reference,
        }),
      ),
      method: "receipt",
      receipt,
    });
    return { response, signature: this.proof.sign("mail-delivery", response) };
  }
  close() {
    this.stopped = true;
  }
}
