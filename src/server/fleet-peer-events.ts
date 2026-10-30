import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { performance } from "node:perf_hooks";
import type { EventSocket } from "../event-socket.js";
import { MachineId } from "../shared/fleet.js";
import { Problem } from "../shared/problem.js";
import {
  FLEET_EVENT_BYTES,
  FLEET_EVENT_BUFFER_BYTES,
  FleetEventSubscription,
  SignedFleetEventResponse,
} from "../shared/fleet-workspace-events.js";
import { directoryDigest } from "./fleet-crypto.js";
import { verifyFleetProof } from "./fleet-proof.js";
import { verifyFleetDestination } from "./fleet-peer-identity.js";
import type { FleetAuthority } from "./fleet-authority.js";
import type { FleetCredentialLeases } from "./fleet-credential-leases.js";
import type { FleetPeerReads } from "./fleet-peer-reads.js";
import type { FleetWorkspaceEventHttpTransport } from "./fleet-workspace-event-http.js";

/** One backend connection per demanded logical source. The gateway multiplexer
 * shares it among viewers; this layer authenticates the owning machine, verifies
 * every frame and never handles browser commands or changes native context. */
export class FleetPeerEvents {
  private readonly active = new Set<AbortController>();
  private readonly unobserve: () => void;
  private stopped = false;
  constructor(
    private readonly authority: FleetAuthority,
    private readonly leases: FleetCredentialLeases,
    private readonly owner: string,
    private readonly reads: FleetPeerReads,
    private readonly transport: FleetWorkspaceEventHttpTransport,
  ) {
    this.unobserve = authority.observe(owner, () => {
      for (const controller of this.active) controller.abort();
    });
  }
  private target(peer: string) {
    MachineId.parse(peer);
    const status = this.authority.status(this.owner),
      document = status.directory?.document;
    const member = document?.members.find((item) => item.machineId === peer);
    if (
      this.stopped ||
      status.state === "removed" ||
      !document ||
      !member ||
      peer === this.authority.identity.machineId ||
      !document.members.some(
        (item) => item.machineId === this.authority.identity.machineId,
      )
    )
      throw new Problem(403, "This machine is not an authorized source.");
    return { member, head: directoryDigest(document) };
  }
  async connect(socket: EventSocket, peer: string, query: URLSearchParams) {
    const target = this.target(peer);
    if (this.active.size >= 24)
      throw new Problem(503, "Source event connections are busy.");
    const controller = new AbortController();
    this.active.add(controller);
    let upstream: WebSocket | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let first: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const abort = () => controller.abort();
    const close = () => {
      upstream?.terminate();
      socket.close(
        1013,
        "Source updates unavailable. Reconcile and reconnect.",
      );
      this.active.delete(controller);
      clearTimeout(expiry);
      clearTimeout(first);
      clearInterval(heartbeat);
      socket.off("close", abort);
    };
    const current = () => {
      if (
        controller.signal.aborted ||
        socket.readyState !== WebSocket.OPEN ||
        this.target(peer).head !== target.head
      )
        throw new Problem(409, "This source subscription changed.");
    };
    socket.once("close", abort);
    controller.signal.addEventListener("abort", close, { once: true });
    let credential:
      Awaited<ReturnType<FleetCredentialLeases["get"]>> | undefined;
    try {
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(30_000),
      ]);
      const catalog = await this.reads.catalog(peer, signal, current, "events");
      current();
      if (!catalog.events)
        throw new Problem(
          409,
          "This source needs an update for event streaming.",
        );
      credential = await this.leases.get(peer, "events");
      current();
      await verifyFleetDestination(target.member, this.transport, signal);
      current();
      upstream = await this.transport.connect(
        target.member.origin,
        credential.token,
        controller.signal,
      );
      current();
      const request = FleetEventSubscription.parse({
        version: 1,
        requestId: randomUUID(),
        epoch: query.get("epoch") ?? "",
        cursor: Number(query.get("cursor") ?? 0),
        conversations: JSON.parse(query.get("conversations") ?? "[]"),
        runs: JSON.parse(query.get("runs") ?? "[]"),
      });
      let sequence = 0,
        alive = true;
      upstream.on("pong", () => {
        alive = true;
      });
      heartbeat = setInterval(() => {
        if (!alive) {
          controller.abort();
          return;
        }
        alive = false;
        upstream?.ping();
      }, 25_000);
      heartbeat.unref();
      expiry = setTimeout(
        abort,
        Math.max(1, credential.expiresAtMonotonic - performance.now()),
      );
      expiry.unref();
      first = setTimeout(abort, 5000);
      first.unref();
      upstream.on("message", (raw, binary) => {
        try {
          current();
          if (
            binary ||
            !Buffer.isBuffer(raw) ||
            raw.length > FLEET_EVENT_BYTES + 4096
          )
            throw new Error();
          const wire = JSON.parse(raw.toString());
          const parsed = SignedFleetEventResponse.parse(wire);
          const response = parsed.response;
          if (
            response.requestId !== request.requestId ||
            response.sequence !== sequence++ ||
            response.machineId !== peer ||
            response.peer !== this.authority.identity.machineId ||
            response.grantId !== target.member.grantId ||
            response.directory !== target.head ||
            !verifyFleetProof(
              {
                machineId: target.member.machineId,
                publicKey: target.member.publicKey,
              },
              "workspace-event",
              // Event decoding intentionally normalizes unknown future events.
              // Authenticate the bounded original payload, then forward only
              // the validated and normalized frame below.
              wire.response,
              parsed.signature,
            )
          )
            throw new Error();
          const text = JSON.stringify(response.frame);
          if (
            socket.bufferedAmount + Buffer.byteLength(text) >
            FLEET_EVENT_BUFFER_BYTES
          )
            throw new Error();
          socket.send(text);
          clearTimeout(first);
        } catch {
          controller.abort();
        }
      });
      upstream.once("close", (code) => {
        if (code === 4001 && credential)
          this.leases.rejected(peer, "events", credential.token);
        controller.abort();
      });
      upstream.once("error", abort);
      upstream.send(JSON.stringify(request));
    } catch (error) {
      if (error instanceof Problem && error.status === 403 && credential)
        this.leases.rejected(peer, "events", credential.token);
      if (error instanceof Problem && error.status === 409)
        this.leases.refreshDirectory();
      controller.abort();
      throw error;
    }
  }
  close() {
    if (this.stopped) return;
    this.stopped = true;
    this.unobserve();
    for (const controller of this.active) controller.abort();
  }
}
