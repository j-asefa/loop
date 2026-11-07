import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { MachineId } from "../shared/fleet.js";
import { Problem } from "../shared/problem.js";
import {
  FleetActionInput,
  FleetActionReceipt,
  FleetActionReference,
  SignedFleetActionResponse,
  fleetActionRoutes,
} from "../shared/fleet-workspace-action-api.js";
import { SignedFleetWorkspaceCatalog } from "../shared/fleet-workspace-api.js";
import { directoryDigest, fleetPayloadDigest } from "./fleet-crypto.js";
import { verifyFleetProof } from "./fleet-proof.js";
import { verifyFleetDestination } from "./fleet-peer-identity.js";
import { fleetActionInput } from "./fleet-workspace-actions.js";
import { ExecutionRefused } from "./execution-refusal.js";
import type { FleetAuthority } from "./fleet-authority.js";
import type { FleetCredentialLeases } from "./fleet-credential-leases.js";
import type { FleetAccessLease } from "./fleet-credential-lease.js";
import type { FleetWorkspaceActionTransport } from "./fleet-workspace-action-http.js";

import { FleetForwardedCommands } from "./fleet-forwarded-commands.js";

type Receipt = z.infer<typeof FleetActionReceipt>;
const unknown = (commandId: string): Receipt => ({
  commandId,
  state: "unknown",
  result: null,
});
const unavailable = () =>
  new Problem(
    503,
    "This machine is temporarily unreachable. Retry or re-pair its changed address.",
  );

/** One owner's forwarding journal. The first action records its immutable
 * destination and digest before transport. Every later attempt, including after
 * restart, only queries that destination's receipt. After dispatch, no timeout
 * or unsigned HTTP response proves refusal. Browser/device checks are callbacks
 * supplied by Host; no forwarded header grants an authenticated delegation. */
export class FleetPeerActions {
  private readonly pending = new Map<AbortController, string>();
  private readonly sending = new Set<string>();
  private readonly unobserve: () => void;
  private stopped = false;
  private readonly journal: FleetForwardedCommands;
  constructor(
    db: Database.Database,
    private readonly authority: FleetAuthority,
    private readonly leases: FleetCredentialLeases,
    private readonly owner: string,
    private readonly transport: FleetWorkspaceActionTransport,
  ) {
    this.journal = new FleetForwardedCommands(db, owner);
    this.unobserve = authority.observe(owner, () => {
      for (const controller of this.pending.keys()) controller.abort();
    });
  }
  private target(peer: string) {
    MachineId.parse(peer);
    const local = this.authority.status(this.owner),
      document = local.directory?.document;
    const member = document?.members.find((item) => item.machineId === peer);
    if (
      this.stopped ||
      !document ||
      local.state === "removed" ||
      !member ||
      peer === this.authority.identity.machineId ||
      !document.members.some(
        (item) => item.machineId === this.authority.identity.machineId,
      )
    )
      throw new ExecutionRefused(
        403,
        "This machine is not an authorized fleet destination.",
      );
    return {
      member,
      head: directoryDigest(document),
      fleetId: document.fleetId,
    };
  }
  private verify(
    reply: unknown,
    target: ReturnType<FleetPeerActions["target"]>,
    requestId: string,
    requestDigest: string,
    commandId: string,
    input: FleetActionReference,
  ) {
    const parsed = SignedFleetActionResponse.safeParse(reply);
    if (
      !parsed.success ||
      parsed.data.response.requestId !== requestId ||
      parsed.data.response.requestDigest !== requestDigest ||
      parsed.data.response.machineId !== target.member.machineId ||
      parsed.data.response.peer !== this.authority.identity.machineId ||
      parsed.data.response.grantId !== target.member.grantId ||
      (parsed.data.response.receipt &&
        parsed.data.response.receipt.commandId !== commandId) ||
      !verifyFleetProof(
        {
          machineId: target.member.machineId,
          publicKey: target.member.publicKey,
        },
        "workspace-action",
        parsed.data.response,
        parsed.data.signature,
      )
    )
      throw new Problem(
        502,
        "The action receipt could not be verified. Keep its original command ID.",
      );
    if (parsed.data.response.directory !== target.head)
      throw new Problem(
        409,
        "The fleet directory changed. Refresh the receipt.",
      );
    const receipt = parsed.data.response.receipt;
    if (!receipt) return unknown(commandId);
    return {
      ...receipt,
      result:
        receipt.result === null
          ? null
          : fleetActionRoutes[input.route].response.parse(receipt.result),
    };
  }
  private async negotiate(
    target: ReturnType<FleetPeerActions["target"]>,
    credential: FleetAccessLease,
    input: FleetActionReference,
    signal: AbortSignal,
  ) {
    const request = {
      version: 1 as const,
      requestId: randomUUID(),
      credential: credential.token,
    };
    const parsed = SignedFleetWorkspaceCatalog.safeParse(
      await this.transport.catalog(target.member.origin, request, signal),
    );
    if (
      !parsed.success ||
      parsed.data.catalog.requestId !== request.requestId ||
      parsed.data.catalog.requestDigest !==
        fleetPayloadDigest({ requestId: request.requestId }) ||
      parsed.data.catalog.machineId !== target.member.machineId ||
      parsed.data.catalog.peer !== this.authority.identity.machineId ||
      parsed.data.catalog.grantId !== target.member.grantId ||
      !verifyFleetProof(
        {
          machineId: target.member.machineId,
          publicKey: target.member.publicKey,
        },
        "workspace-catalog",
        parsed.data.catalog,
        parsed.data.signature,
      )
    )
      throw new Problem(
        502,
        "This machine's workspace capabilities could not be verified.",
      );
    if (parsed.data.catalog.directory !== target.head)
      throw new Problem(
        409,
        "The fleet directory changed. Refresh this source.",
      );
    if (!parsed.data.catalog.actions.includes(input.route))
      throw new ExecutionRefused(
        409,
        "Update this machine to use this workspace action.",
      );
  }
  action(
    peer: string,
    commandId: string,
    input: FleetActionInput,
    current: () => void,
    signal?: AbortSignal,
  ) {
    return this.forward(peer, commandId, input, false, current, signal);
  }
  receipt(
    peer: string,
    commandId: string,
    input: FleetActionInput,
    current: () => void,
    signal?: AbortSignal,
  ) {
    return this.forward(peer, commandId, input, true, current, signal);
  }
  async lookup(
    peer: string,
    commandId: string,
    input: FleetActionReference,
    current: () => void,
    signal?: AbortSignal,
  ) {
    return this.perform(
      peer,
      commandId,
      FleetActionReference.parse(input),
      undefined,
      current,
      signal,
    );
  }
  private async forward(
    peer: string,
    commandId: string,
    input: FleetActionInput,
    receiptOnly: boolean,
    current: () => void,
    signal?: AbortSignal,
  ) {
    const value = fleetActionInput(input, commandId);
    return this.perform(
      peer,
      commandId,
      { route: value.route, payloadDigest: fleetPayloadDigest(value) },
      receiptOnly ? undefined : value,
      current,
      signal,
    );
  }
  private async perform(
    peer: string,
    commandId: string,
    value: FleetActionReference,
    input: FleetActionInput | undefined,
    current: () => void,
    signal?: AbortSignal,
  ): Promise<Receipt> {
    z.string().uuid().parse(commandId);
    const digest = value.payloadDigest,
      receiptOnly = !input;
    current();
    const target = this.target(peer),
      prior = this.journal.stored(commandId);
    if (prior) this.journal.match(prior, target, value, digest);
    if (prior && ["completed", "refused"].includes(prior.state))
      return this.journal.view(commandId, prior);
    // Reserve the first attempt before asynchronous preparation: a concurrent
    // lookup must not consume its right to send. A lookup on a fresh gateway
    // reserves uncertainty instead, so a later action cannot replay that intent.
    const first = this.journal.claim(commandId, target, value, digest);
    const query = receiptOnly || !first;
    // A local lookup must not retire an ID whose original send is still active.
    if (this.sending.has(commandId)) return unknown(commandId);
    if (
      this.pending.size >= 16 ||
      [...this.pending.values()].filter((item) => item === peer).length >= 4
    )
      return unknown(commandId);
    const controller = new AbortController();
    const lifetime = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(45_000),
      ...(signal ? [signal] : []),
    ]);
    this.pending.set(controller, peer);
    let credential: FleetAccessLease | undefined;
    if (!query) this.sending.add(commandId);
    const live = () => {
      current();
      if (lifetime.aborted) throw unavailable();
      if (this.target(peer).head !== target.head)
        throw new Problem(
          409,
          "The fleet directory changed. Refresh this source.",
        );
    };
    let abort!: () => void;
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(unavailable());
      lifetime.addEventListener("abort", abort, { once: true });
    });
    try {
      live();
      await Promise.race([
        verifyFleetDestination(target.member, this.transport, lifetime),
        stopped,
      ]);
      live();
      credential = await Promise.race([this.leases.get(peer, "act"), stopped]);
      live();
      if (!query)
        await Promise.race([
          this.negotiate(target, credential, value, lifetime),
          stopped,
        ]);
      live();
      const admission = {
        version: 1 as const,
        requestId: randomUUID(),
        commandId,
        credential: credential.token,
      };
      // Only the invocation that claimed this identity may send an action.
      // Every other caller and a replacement process can only query its receipt.
      const response = query
        ? this.transport.receipt(
            target.member.origin,
            { ...admission, payloadDigest: digest, route: value.route },
            lifetime,
          )
        : this.transport.action(
            target.member.origin,
            { ...admission, input: input! },
            lifetime,
          );
      const requestDigest = fleetPayloadDigest({
        requestId: admission.requestId,
        commandId,
        ...(query ? { payloadDigest: digest, route: value.route } : { input }),
      });
      const receipt = this.verify(
        await Promise.race([response, stopped]),
        target,
        admission.requestId,
        requestDigest,
        commandId,
        value,
      );
      const saved = this.journal.save(commandId, receipt);
      live();
      return saved;
    } catch (error) {
      // A failure here says nothing about an earlier send through another
      // gateway. Only a verified destination receipt can settle this identity.
      // A local device losing authority is not a peer credential rejection.
      // It must not invalidate another viewer's still-valid machine lease.
      current();
      if (error instanceof Problem && [403, 409].includes(error.status)) {
        if (error.status === 403 && credential)
          this.leases.rejected(peer, "act", credential.token);
        if (error.status === 409) this.leases.refreshDirectory();
      }
      return unknown(commandId);
    } finally {
      lifetime.removeEventListener("abort", abort);
      this.pending.delete(controller);
      if (!query) this.sending.delete(commandId);
    }
  }
  close() {
    if (this.stopped) return;
    this.stopped = true;
    this.unobserve();
    for (const controller of this.pending.keys()) controller.abort();
  }
}
