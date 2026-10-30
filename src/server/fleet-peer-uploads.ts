import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { MachineId } from "../shared/fleet.js";
import { Problem } from "../shared/problem.js";
import { workspaceApi } from "../shared/workspace-api.js";
import { FleetActionReceipt } from "../shared/fleet-workspace-action-api.js";
import { SignedFleetWorkspaceCatalog } from "../shared/fleet-workspace-api.js";
import {
  FleetUploadInput,
  fleetUploadProofInput,
  fleetWorkspaceUploadApi,
} from "../shared/fleet-workspace-upload-api.js";
import { FLEET_FILE_CHUNK_BYTES } from "../shared/fleet-workspace-file-api.js";
import { FleetForwardedCommands } from "./fleet-forwarded-commands.js";
import { directoryDigest, fleetPayloadDigest } from "./fleet-crypto.js";
import { verifyFleetProof } from "./fleet-proof.js";
import { verifyFleetDestination } from "./fleet-peer-identity.js";
import { ExecutionRefused } from "./execution-refusal.js";
import type { FleetAuthority } from "./fleet-authority.js";
import type { FleetCredentialLeases } from "./fleet-credential-leases.js";
import type { FleetAccessLease } from "./fleet-credential-lease.js";
import type { FleetWorkspaceUploadTransport } from "./fleet-workspace-upload-http.js";

type Receipt = z.infer<typeof FleetActionReceipt>;
const unknown = (commandId: string): Receipt => ({
  commandId,
  state: "unknown",
  result: null,
});
const unavailable = () =>
  new Problem(
    503,
    "The upload's machine is unavailable. Check the original receipt before continuing.",
  );
const invalid = () =>
  new Problem(
    502,
    "The upload response could not be verified. Keep the original receipt.",
  );
type Identity = {
  requestId: string;
  requestDigest: string;
  machineId: string;
  peer: string;
  grantId: string;
  directory: string;
};
type UploadIdentity = Identity & { commandId: string; payloadDigest: string };

/** Files consent uses the same durable gateway command namespace as ordinary
 * actions. The first transmission is journaled before even staging bytes. All
 * subsequent calls only query receipts; no timeout reuploads or recommits. */
export class FleetPeerUploads {
  private readonly journal: FleetForwardedCommands;
  private readonly pending = new Map<AbortController, string>();
  private readonly sending = new Set<string>();
  private readonly unobserve: () => void;
  private stopped = false;
  constructor(
    db: Database.Database,
    private readonly authority: FleetAuthority,
    private readonly leases: FleetCredentialLeases,
    private readonly owner: string,
    private readonly transport: FleetWorkspaceUploadTransport,
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
        "This machine is not an authorized upload destination.",
      );
    return {
      member,
      head: directoryDigest(document),
      fleetId: document.fleetId,
    };
  }
  private verify(
    target: ReturnType<FleetPeerUploads["target"]>,
    value: Identity,
    signature: string,
    purpose: Parameters<typeof verifyFleetProof>[1],
    requestDigest: string,
    requestId: string,
  ) {
    if (
      value.requestId !== requestId ||
      value.requestDigest !== requestDigest ||
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
        "Upload permissions changed. Check the original receipt.",
      );
  }
  private uploadProof(
    target: ReturnType<FleetPeerUploads["target"]>,
    value: UploadIdentity,
    signature: string,
    purpose: Parameters<typeof verifyFleetProof>[1],
    request: { credential: string; requestId: string; commandId: string },
    digest: string,
  ) {
    this.verify(
      target,
      value,
      signature,
      purpose,
      fleetPayloadDigest(fleetUploadProofInput(request)),
      request.requestId,
    );
    if (value.commandId !== request.commandId || value.payloadDigest !== digest)
      throw invalid();
  }
  private receipt(commandId: string, input: Receipt | null): Receipt {
    if (!input) return unknown(commandId);
    if (input.commandId !== commandId) throw invalid();
    return {
      ...input,
      result:
        input.result === null
          ? null
          : workspaceApi.uploadCreate.response.parse(input.result),
    };
  }
  upload(
    peer: string,
    commandId: string,
    input: FleetUploadInput,
    bytes: Buffer,
    current: () => void,
    signal?: AbortSignal,
  ) {
    const value = FleetUploadInput.parse(input);
    if (
      bytes.length !== value.body.file.size ||
      createHash("sha256").update(bytes).digest("hex") !==
        value.body.file.checksum
    )
      throw new ExecutionRefused(
        409,
        "The upload bytes changed before forwarding.",
      );
    return this.perform(
      peer,
      commandId,
      fleetPayloadDigest(value),
      { input: value, bytes },
      current,
      signal,
    );
  }
  lookup(
    peer: string,
    commandId: string,
    payloadDigest: string,
    current: () => void,
    signal?: AbortSignal,
  ) {
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(payloadDigest);
    return this.perform(
      peer,
      commandId,
      payloadDigest,
      undefined,
      current,
      signal,
    );
  }
  private async perform(
    peer: string,
    commandId: string,
    digest: string,
    file: { input: FleetUploadInput; bytes: Buffer } | undefined,
    current: () => void,
    signal?: AbortSignal,
  ): Promise<Receipt> {
    z.string().uuid().parse(commandId);
    current();
    const target = this.target(peer),
      reference = { route: "uploadCreate" as const, payloadDigest: digest };
    const prior = this.journal.stored(commandId);
    if (prior) this.journal.match(prior, target, reference, digest);
    if (prior && ["completed", "refused"].includes(prior.state))
      return this.journal.view(commandId, prior);
    const first = this.journal.claim(commandId, target, reference, digest);
    const query = !file || !first;
    if (this.sending.has(commandId)) return unknown(commandId);
    if (
      this.pending.size >= 4 ||
      [...this.pending.values()].filter((value) => value === peer).length >= 2
    )
      return unknown(commandId);
    const controller = new AbortController();
    const lifetime = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(120_000),
      ...(signal ? [signal] : []),
    ]);
    this.pending.set(controller, peer);
    if (!query) this.sending.add(commandId);
    const live = () => {
      current();
      if (lifetime.aborted) throw unavailable();
      if (this.target(peer).head !== target.head)
        throw new Problem(
          409,
          "Upload permissions changed. Keep the original receipt.",
        );
    };
    let abort!: () => void;
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(unavailable());
      lifetime.addEventListener("abort", abort, { once: true });
    });
    const call = async <T>(run: () => Promise<T>) => {
      live();
      const value = await Promise.race([run(), stopped]);
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
        commandId,
        credential: credential.token,
      };
    };
    try {
      if (query || !file) {
        const request = { ...(await admission()), payloadDigest: digest };
        const reply = fleetWorkspaceUploadApi.receipt.response.parse(
          await call(() =>
            this.transport.receipt(target.member.origin, request, lifetime),
          ),
        );
        this.uploadProof(
          target,
          reply.response,
          reply.signature,
          "workspace-upload-receipt",
          request,
          digest,
        );
        return this.journal.save(
          commandId,
          this.receipt(commandId, reply.response.receipt),
        );
      }
      const { commandId: _commandId, ...catalogRequest } = await admission();
      const catalog = SignedFleetWorkspaceCatalog.parse(
        await call(() =>
          this.transport.catalog(
            target.member.origin,
            catalogRequest,
            lifetime,
          ),
        ),
      );
      this.verify(
        target,
        catalog.catalog,
        catalog.signature,
        "workspace-catalog",
        fleetPayloadDigest({ requestId: catalogRequest.requestId }),
        catalogRequest.requestId,
      );
      if (!catalog.catalog.actions.includes("uploadCreate"))
        throw new ExecutionRefused(
          409,
          "Update or re-pair this machine with files access to upload here.",
        );
      const prepare = { ...(await admission()), input: file.input };
      const staged = fleetWorkspaceUploadApi.prepare.response.parse(
        await call(() => {
          return this.transport.prepare(
            target.member.origin,
            prepare,
            lifetime,
          );
        }),
      );
      this.uploadProof(
        target,
        staged.response,
        staged.signature,
        "workspace-upload-prepare",
        prepare,
        digest,
      );
      if (staged.response.receipt)
        return this.journal.save(
          commandId,
          this.receipt(commandId, staged.response.receipt),
        );
      if (!staged.response.transferId || staged.response.nextOffset !== 0)
        throw invalid();
      transferId = staged.response.transferId;
      for (
        let offset = 0;
        offset < file.bytes.length;
        offset += FLEET_FILE_CHUNK_BYTES
      ) {
        const nextOffset = Math.min(
          offset + FLEET_FILE_CHUNK_BYTES,
          file.bytes.length,
        );
        const request = {
          ...(await admission()),
          transferId,
          payloadDigest: digest,
          offset,
          base64: file.bytes.subarray(offset, nextOffset).toString("base64"),
        };
        const reply = fleetWorkspaceUploadApi.chunk.response.parse(
          await call(() =>
            this.transport.chunk(target.member.origin, request, lifetime),
          ),
        );
        this.uploadProof(
          target,
          reply.response,
          reply.signature,
          "workspace-upload-chunk",
          request,
          digest,
        );
        if (
          reply.response.transferId !== transferId ||
          reply.response.nextOffset !== nextOffset
        )
          throw invalid();
      }
      const request = {
        ...(await admission()),
        transferId,
        input: file.input,
      };
      // One commit per gateway command. A lost response only enables receipt reads.
      const reply = fleetWorkspaceUploadApi.commit.response.parse(
        await call(() =>
          this.transport.commit(target.member.origin, request, lifetime),
        ),
      );
      this.uploadProof(
        target,
        reply.response,
        reply.signature,
        "workspace-upload-receipt",
        request,
        digest,
      );
      return this.journal.save(
        commandId,
        this.receipt(commandId, reply.response.receipt),
      );
    } catch (error) {
      // A different gateway may already have committed this upload. Only the
      // destination can establish a terminal outcome for its durable identity.
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
      return unknown(commandId);
    } finally {
      lifetime.removeEventListener("abort", abort);
      controller.abort();
      try {
        if (
          transferId &&
          credential &&
          identityCurrent &&
          this.target(peer).head === target.head
        ) {
          const signal = AbortSignal.timeout(1000);
          let abort!: () => void;
          const timeout = new Promise<never>((_, reject) => {
            abort = () => reject(unavailable());
            signal.addEventListener("abort", abort, { once: true });
          });
          const request = {
            version: 1 as const,
            requestId: randomUUID(),
            commandId,
            credential: credential.token,
            transferId,
            payloadDigest: digest,
          };
          try {
            const reply = fleetWorkspaceUploadApi.close.response.parse(
              await Promise.race([
                (async () => {
                  await verifyFleetDestination(
                    target.member,
                    this.transport,
                    signal,
                  );
                  if (signal.aborted || this.target(peer).head !== target.head)
                    throw unavailable();
                  return this.transport.release(
                    target.member.origin,
                    request,
                    signal,
                  );
                })(),
                timeout,
              ]),
            );
            this.uploadProof(
              target,
              reply.response,
              reply.signature,
              "workspace-upload-close",
              request,
              digest,
            );
            if (reply.response.transferId !== transferId) throw invalid();
          } finally {
            signal.removeEventListener("abort", abort);
          }
        }
      } catch {
        /* Unreachable staging expires; cleanup never commits a file. */
      }
      this.pending.delete(controller);
      if (!query) this.sending.delete(commandId);
    }
  }
  close() {
    this.stopped = true;
    this.unobserve();
    for (const controller of this.pending.keys()) controller.abort();
  }
}
