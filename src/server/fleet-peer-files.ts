import { createHash, randomUUID } from "node:crypto";
import { MachineId } from "../shared/fleet.js";
import { Problem } from "../shared/problem.js";
import {
  FleetFileSelection,
  type FleetFileMetadata,
  FLEET_FILE_CHUNK_BYTES,
  fleetWorkspaceFileApi,
} from "../shared/fleet-workspace-file-api.js";
import { SignedFleetWorkspaceCatalog } from "../shared/fleet-workspace-api.js";
import { directoryDigest, fleetPayloadDigest } from "./fleet-crypto.js";
import { verifyFleetProof } from "./fleet-proof.js";
import { verifyFleetDestination } from "./fleet-peer-identity.js";
import type { FleetAuthority } from "./fleet-authority.js";
import type { FleetCredentialLeases } from "./fleet-credential-leases.js";
import type { FleetAccessLease } from "./fleet-credential-lease.js";
import type { FleetWorkspaceFileTransport } from "./fleet-workspace-file-http.js";

const unavailable = () =>
  new Problem(
    503,
    "This file's machine is unavailable. Retry or re-pair its changed address.",
  );
const invalid = () =>
  new Problem(502, "The remote file could not be verified. Open it again.");
type Identity = {
  requestId: string;
  requestDigest: string;
  machineId: string;
  peer: string;
  grantId: string;
  directory: string;
};

/** Demand-only file streaming for one gateway owner. Only verified chunks enter
 * the consumer; its awaited writes provide backpressure. The final chunk stays
 * withheld until the complete byte count and SHA-256 match the signed manifest.
 * No files, cookies, native context or transfer credential are kept in a cache. */
export class FleetPeerFiles {
  private readonly pending = new Map<AbortController, string>();
  private readonly unobserve: () => void;
  private stopped = false;
  constructor(
    private readonly authority: FleetAuthority,
    private readonly leases: FleetCredentialLeases,
    private readonly owner: string,
    private readonly transport: FleetWorkspaceFileTransport,
  ) {
    this.unobserve = authority.observe(owner, () => {
      for (const controller of this.pending.keys()) controller.abort();
    });
  }
  private target(peer: string) {
    MachineId.parse(peer);
    const local = this.authority.status(this.owner),
      document = local.directory?.document;
    const member = document?.members.find((value) => value.machineId === peer);
    if (
      this.stopped ||
      !document ||
      local.state === "removed" ||
      !member ||
      peer === this.authority.identity.machineId ||
      !document.members.some(
        (value) => value.machineId === this.authority.identity.machineId,
      )
    )
      throw new Problem(403, "This machine is not an authorized file source.");
    return { member, head: directoryDigest(document) };
  }
  private verify(
    target: ReturnType<FleetPeerFiles["target"]>,
    value: Identity,
    signature: string,
    purpose:
      | "workspace-catalog"
      | "workspace-file-open"
      | "workspace-file-chunk"
      | "workspace-file-close",
    request: Record<string, unknown> & { requestId: string },
  ) {
    if (
      value.requestId !== request.requestId ||
      value.requestDigest !== fleetPayloadDigest(request) ||
      value.machineId !== target.member.machineId ||
      value.peer !== this.authority.identity.machineId ||
      value.grantId !== target.member.grantId ||
      !verifyFleetProof(
        {
          machineId: target.member.machineId,
          publicKey: target.member.publicKey,
        },
        purpose,
        value,
        signature,
      )
    )
      throw invalid();
    if (value.directory !== target.head)
      throw new Problem(
        409,
        "File permissions changed. Refresh this machine and open the file again.",
      );
  }
  async download(
    peer: string,
    input: FleetFileSelection,
    receive: {
      start: (file: FleetFileMetadata) => void | Promise<void>;
      write: (chunk: Buffer) => void | Promise<void>;
    },
    current: () => void = () => {},
    signal?: AbortSignal,
  ) {
    const selection = FleetFileSelection.parse(input);
    current();
    const target = this.target(peer);
    if (
      this.pending.size >= 8 ||
      [...this.pending.values()].filter((value) => value === peer).length >= 2
    )
      throw new Problem(
        503,
        "File downloads are busy. Finish a download and try again.",
      );
    const controller = new AbortController();
    const lifetime = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(120_000),
      ...(signal ? [signal] : []),
    ]);
    this.pending.set(controller, peer);
    const live = () => {
      current();
      if (lifetime.aborted) throw unavailable();
      if (this.target(peer).head !== target.head)
        throw new Problem(
          409,
          "File permissions changed. Open the file again.",
        );
    };
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(unavailable());
      lifetime.addEventListener("abort", abort, { once: true });
    });
    const call = async <T>(run: () => Promise<T>) => {
      live();
      const value = await Promise.race([run(), cancelled]);
      live();
      return value;
    };
    let credential: FleetAccessLease | undefined,
      transferId: string | undefined;
    let identityCurrent = false;
    const admission = async () => {
      identityCurrent = false;
      await call(() =>
        verifyFleetDestination(target.member, this.transport, lifetime),
      );
      identityCurrent = true;
      credential = await call(() => this.leases.get(peer, "files"));
      return {
        version: 1 as const,
        requestId: randomUUID(),
        credential: credential.token,
      };
    };
    try {
      const catalogRequest = await admission();
      const catalog = SignedFleetWorkspaceCatalog.safeParse(
        await call(() =>
          this.transport.catalog(
            target.member.origin,
            catalogRequest,
            lifetime,
          ),
        ),
      );
      if (!catalog.success) throw invalid();
      this.verify(
        target,
        catalog.data.catalog,
        catalog.data.signature,
        "workspace-catalog",
        { requestId: catalogRequest.requestId },
      );
      if (!catalog.data.catalog.files)
        throw new Problem(
          409,
          "This machine does not support fleet downloads. Update or re-pair it with files access.",
        );
      const request = { ...(await admission()), selection };
      const opened = fleetWorkspaceFileApi.open.response.safeParse(
        await call(() =>
          this.transport.open(target.member.origin, request, lifetime),
        ),
      );
      if (!opened.success) throw invalid();
      this.verify(
        target,
        opened.data.response,
        opened.data.signature,
        "workspace-file-open",
        { requestId: request.requestId, selection },
      );
      transferId = opened.data.response.transferId;
      const file = opened.data.response.file,
        hash = createHash("sha256");
      let offset = 0,
        started = false;
      for (;;) {
        const request = { ...(await admission()), transferId, offset };
        const reply = fleetWorkspaceFileApi.chunk.response.safeParse(
          await call(() =>
            this.transport.chunk(target.member.origin, request, lifetime),
          ),
        );
        if (!reply.success) throw invalid();
        const value = reply.data.response;
        this.verify(
          target,
          value,
          reply.data.signature,
          "workspace-file-chunk",
          { requestId: request.requestId, transferId, offset },
        );
        const end = Math.min(file.size, offset + FLEET_FILE_CHUNK_BYTES);
        if (
          value.transferId !== transferId ||
          value.offset !== offset ||
          value.checksum !== file.checksum ||
          value.nextOffset !== (end < file.size ? end : null)
        )
          throw invalid();
        const bytes = Buffer.from(value.base64, "base64");
        if (
          bytes.length !== end - offset ||
          bytes.toString("base64") !== value.base64
        )
          throw invalid();
        hash.update(bytes);
        if (end === file.size && hash.digest("hex") !== file.checksum)
          throw invalid();
        if (!started) {
          await call(async () => {
            await receive.start(file);
          });
          started = true;
        }
        await call(async () => {
          await receive.write(bytes);
        });
        if (end === file.size) break;
        offset = end;
      }
      live();
    } catch (error) {
      // Device revocation is local and must not discard another viewer's lease.
      current();
      if (
        error instanceof Problem &&
        error.status === 403 &&
        credential &&
        identityCurrent
      )
        this.leases.rejected(peer, "files", credential.token);
      if (error instanceof Problem && error.status === 409)
        this.leases.refreshDirectory();
      throw error;
    } finally {
      lifetime.removeEventListener("abort", abort);
      controller.abort();
      try {
        // This fixed cleanup only deletes an ephemeral snapshot. Skip a changed
        // origin or authority; the destination's idle expiry is the fallback.
        if (
          transferId &&
          credential &&
          identityCurrent &&
          this.target(peer).head === target.head
        ) {
          const close = AbortSignal.timeout(1000);
          let cleanupAbort!: () => void;
          const timedOut = new Promise<never>((_, reject) => {
            cleanupAbort = () => reject(unavailable());
            close.addEventListener("abort", cleanupAbort, { once: true });
          });
          try {
            const request = {
              version: 1 as const,
              requestId: randomUUID(),
              credential: credential.token,
              transferId,
            };
            const reply = fleetWorkspaceFileApi.close.response.safeParse(
              await Promise.race([
                (async () => {
                  await verifyFleetDestination(
                    target.member,
                    this.transport,
                    close,
                  );
                  if (close.aborted || this.target(peer).head !== target.head)
                    throw unavailable();
                  return this.transport.release(
                    target.member.origin,
                    request,
                    close,
                  );
                })(),
                timedOut,
              ]),
            );
            if (!reply.success || reply.data.response.transferId !== transferId)
              throw invalid();
            this.verify(
              target,
              reply.data.response,
              reply.data.signature,
              "workspace-file-close",
              { requestId: request.requestId, transferId },
            );
          } finally {
            close.removeEventListener("abort", cleanupAbort);
          }
        }
      } catch {
        /* Lost cleanup does not grant access or repeat a download. */
      }
      this.pending.delete(controller);
    }
  }
  close() {
    this.stopped = true;
    this.unobserve();
    for (const controller of this.pending.keys()) controller.abort();
  }
}
