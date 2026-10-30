import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { z } from "zod";
import { MachineId } from "../shared/fleet.js";
import { Problem } from "../shared/problem.js";
import {
  FleetReadInput,
  FleetWorkspaceCatalog,
  SignedFleetReadResponse,
  SignedFleetWorkspaceCatalog,
  fleetReadRoutes,
} from "../shared/fleet-workspace-api.js";
import { directoryDigest, fleetPayloadDigest } from "./fleet-crypto.js";
import { verifyFleetProof } from "./fleet-proof.js";
import type { FleetAuthority } from "./fleet-authority.js";
import type { FleetCredentialLeases } from "./fleet-credential-leases.js";
import type { FleetWorkspaceTransport } from "./fleet-workspace-http.js";
import type { FleetAccessLease } from "./fleet-credential-lease.js";
import { verifyFleetDestination } from "./fleet-peer-identity.js";

type Catalog = z.infer<typeof FleetWorkspaceCatalog>;
const unavailable = () =>
  new Problem(
    503,
    "This machine is temporarily unreachable. Retry or re-pair its changed address.",
  );
/** One local owner's bounded peer reader. No cookie, device grant, arbitrary
 * URL or recursive source catalog crosses the machine boundary. Directory
 * observers cancel stale responses; callers retain their source identity. */
export class FleetPeerReads {
  private readonly catalogs = new Map<
    string,
    { at: number; head: string; value: Catalog }
  >();
  private readonly pending = new Map<AbortController, string>();
  private readonly unobserve: () => void;
  private stopped = false;
  constructor(
    private readonly authority: FleetAuthority,
    private readonly leases: FleetCredentialLeases,
    private readonly owner: string,
    private readonly transport: FleetWorkspaceTransport,
  ) {
    this.unobserve = authority.observe(owner, () => {
      this.catalogs.clear();
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
      throw new Problem(403, "This machine is not an authorized fleet source.");
    return { member, head: directoryDigest(document) };
  }
  generation(peer: string) {
    return this.target(peer).head;
  }
  private async perform<T>(
    peer: string,
    signal: AbortSignal | undefined,
    run: (
      target: ReturnType<FleetPeerReads["target"]>,
      credential: FleetAccessLease,
      signal: AbortSignal,
      live: () => void,
    ) => Promise<T>,
    current: () => void,
    operation: "read" | "events" = "read",
  ) {
    current();
    const target = this.target(peer);
    if (
      this.pending.size >= 16 ||
      [...this.pending.values()].filter((value) => value === peer).length >= 4
    )
      throw new Problem(503, "Fleet reads are busy. Retry later.");
    const controller = new AbortController();
    const lifetime = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(45_000),
      ...(signal ? [signal] : []),
    ]);
    this.pending.set(controller, peer);
    const live = () => {
      current();
      if (lifetime.aborted) throw unavailable();
      if (this.target(peer).head !== target.head)
        throw new Problem(
          409,
          "The fleet directory changed. Refresh this source.",
        );
    };
    let credential: FleetAccessLease | undefined;
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
      credential = await Promise.race([
        this.leases.get(peer, operation),
        stopped,
      ]);
      live();
      const value = await Promise.race([
        run(target, credential, lifetime, live),
        stopped,
      ]);
      live();
      return value;
    } catch (error) {
      current();
      if (error instanceof Problem && [403, 409].includes(error.status)) {
        this.catalogs.delete(peer);
        if (error.status === 403 && credential)
          this.leases.rejected(peer, operation, credential.token);
        if (error.status === 409) this.leases.refreshDirectory();
      }
      throw error;
    } finally {
      lifetime.removeEventListener("abort", abort);
      this.pending.delete(controller);
    }
  }
  private async negotiate(
    target: ReturnType<FleetPeerReads["target"]>,
    credential: FleetAccessLease,
    signal: AbortSignal,
    live: () => void,
  ) {
    const peer = target.member.machineId;
    const cached = this.catalogs.get(peer),
      now = performance.now();
    if (
      cached?.head === target.head &&
      now >= cached.at &&
      now - cached.at < 60_000
    )
      return structuredClone(cached.value);
    const request = {
      version: 1 as const,
      requestId: randomUUID(),
      credential: credential.token,
    };
    const reply = SignedFleetWorkspaceCatalog.safeParse(
      await this.transport.catalog(target.member.origin, request, signal),
    );
    live();
    if (
      !reply.success ||
      reply.data.catalog.requestId !== request.requestId ||
      reply.data.catalog.requestDigest !==
        fleetPayloadDigest({ requestId: request.requestId }) ||
      reply.data.catalog.machineId !== peer ||
      reply.data.catalog.peer !== this.authority.identity.machineId ||
      reply.data.catalog.grantId !== target.member.grantId ||
      !verifyFleetProof(
        {
          machineId: target.member.machineId,
          publicKey: target.member.publicKey,
        },
        "workspace-catalog",
        reply.data.catalog,
        reply.data.signature,
      )
    )
      throw new Problem(
        502,
        "This machine's workspace capabilities could not be verified.",
      );
    if (reply.data.catalog.directory !== target.head)
      throw new Problem(
        409,
        "The fleet directory changed. Refresh this source.",
      );
    this.catalogs.set(peer, {
      at: performance.now(),
      head: target.head,
      value: structuredClone(reply.data.catalog),
    });
    return reply.data.catalog;
  }
  catalog(
    peer: string,
    signal?: AbortSignal,
    current: () => void = () => {},
    operation: "read" | "events" = "read",
  ) {
    return this.perform(
      peer,
      signal,
      (target, credential, lifetime, live) =>
        this.negotiate(target, credential, lifetime, live),
      current,
      operation,
    );
  }
  read(
    peer: string,
    input: FleetReadInput,
    signal?: AbortSignal,
    current: () => void = () => {},
  ) {
    const value = FleetReadInput.parse(input);
    return this.perform(
      peer,
      signal,
      async (target, credential, lifetime, live) => {
        const catalog = await this.negotiate(
          target,
          credential,
          lifetime,
          live,
        );
        if (!catalog.reads.includes(value.route))
          throw new Problem(
            409,
            "Update this machine to use this workspace operation.",
          );
        live();
        const request = {
          version: 1 as const,
          requestId: randomUUID(),
          credential: credential.token,
          input: value,
        };
        const reply = SignedFleetReadResponse.safeParse(
          await this.transport.read(target.member.origin, request, lifetime),
        );
        live();
        if (
          !reply.success ||
          reply.data.response.requestId !== request.requestId ||
          reply.data.response.requestDigest !==
            fleetPayloadDigest({
              requestId: request.requestId,
              input: value,
            }) ||
          reply.data.response.machineId !== peer ||
          reply.data.response.peer !== this.authority.identity.machineId ||
          reply.data.response.grantId !== target.member.grantId ||
          !verifyFleetProof(
            {
              machineId: target.member.machineId,
              publicKey: target.member.publicKey,
            },
            "workspace-read",
            reply.data.response,
            reply.data.signature,
          )
        )
          throw new Problem(
            502,
            "This machine's workspace response could not be verified.",
          );
        if (reply.data.response.directory !== target.head)
          throw new Problem(
            409,
            "The fleet directory changed. Refresh this source.",
          );
        const parsed = fleetReadRoutes[value.route].response.safeParse(
          reply.data.response.result,
        );
        if (!parsed.success)
          throw new Problem(
            502,
            "This machine returned an incompatible workspace projection.",
          );
        return { result: parsed.data, clock: reply.data.response.clock };
      },
      current,
    );
  }
  close() {
    if (this.stopped) return;
    this.stopped = true;
    this.unobserve();
    this.catalogs.clear();
    for (const controller of this.pending.keys()) controller.abort();
  }
}
