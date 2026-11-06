import * as foldersQueries from "./sql/folders.js";
import * as agentsQueries from "./sql/agents.js";
import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import type { FleetGrantContext } from "../shared/fleet.js";
import { Problem } from "../shared/problem.js";
import { workspaceApi } from "../shared/workspace-api.js";
import {
  FleetUploadInput,
  FleetUploadPrepared,
  FleetUploadChunked,
  FleetUploadClosed,
  FleetUploadReceipt,
  fleetUploadProofInput,
  fleetWorkspaceUploadApi,
} from "../shared/fleet-workspace-upload-api.js";
import { FLEET_FILE_CHUNK_BYTES } from "../shared/fleet-workspace-file-api.js";
import type { FleetAuthority } from "./fleet-authority.js";
import type { FleetCredentials } from "./fleet-credentials.js";
import { FleetProof } from "./fleet-proof.js";
import { FleetCommands, type FleetCommandReceipt } from "./fleet-commands.js";
import { directoryDigest, fleetPayloadDigest } from "./fleet-crypto.js";
import { ExecutionRefused } from "./execution-refusal.js";
import { withFleetAction } from "./fleet-action-context.js";
import type { uploadFile } from "./uploads.js";

type Admission = { context: FleetGrantContext; directory: string };
type Stage = Admission & {
  commandId: string;
  digest: string;
  input: FleetUploadInput;
  bytes: Buffer;
  offset: number;
  idle: number;
  expires: number;
  dispose: () => void;
};
type Request = { requestId: string; commandId: string; credential: string };

/** A bounded ephemeral staging area precedes the owning upload transaction.
 * Staging neither creates a workspace file nor grants agent access. Commit
 * records the original command before invoking the existing owning producer;
 * subsequent attempts only return that receipt, including after a restart. */
const ownedQueries = {
  folders: foldersQueries.existsOwned,
  agents: agentsQueries.existsOwned,
};

export class FleetWorkspaceUploads {
  private readonly proof: FleetProof;
  private readonly commands: FleetCommands;
  private readonly stages = new Map<string, Stage>();
  private readonly unobserve: () => void;
  private stopped = false;
  private pending = 0;
  private timer?: NodeJS.Timeout;
  constructor(
    private readonly db: Database.Database,
    private readonly authority: FleetAuthority,
    private readonly credentials: FleetCredentials,
    private readonly owner: string,
    secrets: ConstructorParameters<typeof FleetProof>[2],
    private readonly apply: typeof uploadFile,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.proof = new FleetProof(db, authority.identity, secrets);
    this.commands = new FleetCommands(db, authority);
    this.unobserve = authority.observe(owner, () => this.clear());
  }
  private active() {
    if (this.stopped)
      throw new ExecutionRefused(
        403,
        "This workspace does not admit fleet uploads.",
      );
  }
  private authorize(credential: string): Admission {
    this.active();
    const accepted = this.credentials.authenticate(credential);
    if (accepted.owner !== this.owner || accepted.context.operation !== "files")
      throw new ExecutionRefused(
        403,
        "This credential cannot upload workspace files.",
      );
    const directory = this.authority.directory(this.owner);
    if (!directory)
      throw new ExecutionRefused(403, "The fleet directory is unavailable.");
    return {
      context: accepted.context,
      directory: directoryDigest(directory.document),
    };
  }
  private current(admission: Admission) {
    this.active();
    const context = admission.context;
    this.authority.acceptedGrant(
      this.owner,
      context.peer,
      context.fleetId,
      context.grantId,
      "files",
    );
    const directory = this.authority.directory(this.owner);
    if (
      !directory ||
      directoryDigest(directory.document) !== admission.directory
    )
      throw new ExecutionRefused(
        409,
        "Upload permissions changed. Check the original receipt.",
      );
  }
  private owned(input: FleetUploadInput) {
    for (const [table, id] of [
      ["folders", input.body.options.folderId],
      ["agents", input.body.options.agentId],
    ] as const) {
      if (id && !ownedQueries[table](this.db, id, this.owner))
        throw new ExecutionRefused(
          404,
          "The upload destination is unavailable.",
        );
    }
  }
  private drop(id: string) {
    this.stages.get(id)?.dispose();
    this.stages.delete(id);
  }
  private clear() {
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const id of this.stages.keys()) this.drop(id);
  }
  private sweep() {
    const now = this.now();
    for (const [id, stage] of this.stages)
      if (stage.idle <= now || stage.expires <= now) this.drop(id);
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.stages.size) {
      const next = Math.min(
        ...[...this.stages.values()].map((stage) =>
          Math.min(stage.idle, stage.expires),
        ),
      );
      this.timer = setTimeout(() => this.sweep(), Math.max(1, next - now));
      this.timer.unref();
    }
  }
  private identity(request: Request, admission: Admission, digest: string) {
    return {
      version: 1 as const,
      requestId: request.requestId,
      commandId: request.commandId,
      machineId: this.authority.identity.machineId,
      peer: admission.context.peer,
      grantId: admission.context.grantId,
      directory: admission.directory,
      requestDigest: fleetPayloadDigest(fleetUploadProofInput(request)),
      payloadDigest: digest,
    };
  }
  prepare(input: unknown, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const request = fleetWorkspaceUploadApi.prepare.body.parse(input);
    const admission = this.authorize(request.credential);
    const digest = fleetPayloadDigest(request.input);
    const receipt = this.commands.receipt(
      admission.context,
      request.commandId,
      digest,
      "uploadCreate",
    );
    let transferId: string | null = null,
      offset = 0;
    this.sweep();
    if (!receipt) {
      this.owned(request.input);
      const prior = [...this.stages].find(
        ([, stage]) => stage.commandId === request.commandId,
      );
      if (prior) {
        this.match(prior[1], admission, request.commandId, digest);
        transferId = prior[0];
        offset = prior[1].offset;
      } else {
        if (this.stages.size + this.pending >= 2)
          throw new Problem(
            503,
            "Uploads are busy. Finish an upload and try again.",
          );
        transferId = randomUUID();
        const id = transferId;
        const abort = () => {
          this.drop(id);
          this.sweep();
        };
        const now = this.now();
        this.stages.set(id, {
          ...admission,
          commandId: request.commandId,
          digest,
          input: request.input,
          bytes: Buffer.alloc(request.input.body.file.size),
          offset: 0,
          idle: now + 30_000,
          expires: now + 120_000,
          dispose: () => signal?.removeEventListener("abort", abort),
        });
        signal?.addEventListener("abort", abort, { once: true });
        this.sweep();
      }
    }
    const response = FleetUploadPrepared.parse({
      ...this.identity(request, admission, digest),
      transferId,
      nextOffset: offset,
      chunkBytes: FLEET_FILE_CHUNK_BYTES,
      receipt,
    });
    return {
      response,
      signature: this.proof.sign("workspace-upload-prepare", response),
    };
  }
  private match(
    stage: Stage,
    admission: Admission,
    commandId: string,
    digest: string,
  ) {
    if (
      stage.context.peer !== admission.context.peer ||
      stage.context.grantId !== admission.context.grantId ||
      stage.context.fleetId !== admission.context.fleetId ||
      stage.directory !== admission.directory ||
      stage.commandId !== commandId ||
      stage.digest !== digest
    )
      throw new Problem(
        409,
        "This upload belongs to a different command or permission.",
      );
  }
  private stage(
    id: string,
    admission: Admission,
    commandId: string,
    digest: string,
  ) {
    this.sweep();
    const stage = this.stages.get(id);
    if (!stage)
      throw new Problem(404, "The staged upload expired or is unavailable.");
    this.match(stage, admission, commandId, digest);
    this.owned(stage.input);
    return stage;
  }
  chunk(input: unknown) {
    const request = fleetWorkspaceUploadApi.chunk.body.parse(input);
    const admission = this.authorize(request.credential);
    const stage = this.stage(
      request.transferId,
      admission,
      request.commandId,
      request.payloadDigest,
    );
    const bytes = Buffer.from(request.base64, "base64");
    if (
      bytes.length === 0 ||
      bytes.toString("base64") !== request.base64 ||
      bytes.length > FLEET_FILE_CHUNK_BYTES ||
      request.offset !== stage.offset ||
      stage.offset + bytes.length > stage.bytes.length
    )
      throw new Problem(
        409,
        "The upload bytes do not match the expected position or size.",
      );
    bytes.copy(stage.bytes, stage.offset);
    stage.offset += bytes.length;
    stage.idle = this.now() + 30_000;
    this.sweep();
    const response = FleetUploadChunked.parse({
      ...this.identity(request, admission, stage.digest),
      transferId: request.transferId,
      nextOffset: stage.offset,
    });
    return {
      response,
      signature: this.proof.sign("workspace-upload-chunk", response),
    };
  }
  release(input: unknown) {
    const request = fleetWorkspaceUploadApi.close.body.parse(input);
    const admission = this.authorize(request.credential);
    this.sweep();
    const stage = this.stages.get(request.transferId);
    if (stage) {
      this.match(stage, admission, request.commandId, request.payloadDigest);
      this.drop(request.transferId);
      this.sweep();
    }
    const response = FleetUploadClosed.parse({
      ...this.identity(request, admission, request.payloadDigest),
      transferId: request.transferId,
      closed: true,
    });
    return {
      response,
      signature: this.proof.sign("workspace-upload-close", response),
    };
  }
  private signed(
    request: Request,
    digest: string,
    receipt: FleetCommandReceipt | null,
  ) {
    const admission = this.authorize(request.credential);
    const response = FleetUploadReceipt.parse({
      ...this.identity(request, admission, digest),
      receipt,
    });
    return {
      response,
      signature: this.proof.sign("workspace-upload-receipt", response),
    };
  }
  async commit(input: unknown) {
    const request = fleetWorkspaceUploadApi.commit.body.parse(input);
    const admission = this.authorize(request.credential);
    const digest = fleetPayloadDigest(request.input);
    const prior = this.commands.receipt(
      admission.context,
      request.commandId,
      digest,
      "uploadCreate",
    );
    if (prior) return this.signed(request, digest, prior);
    const stage = this.stage(
      request.transferId,
      admission,
      request.commandId,
      digest,
    );
    if (
      stage.offset !== stage.bytes.length ||
      createHash("sha256").update(stage.bytes).digest("hex") !==
        stage.input.body.file.checksum
    )
      throw new ExecutionRefused(
        409,
        "The complete upload checksum could not be verified.",
      );
    this.drop(request.transferId);
    this.sweep();
    this.pending++;
    try {
      const receipt = await this.commands.execute(
        admission.context,
        request.commandId,
        request.input,
        workspaceApi.uploadCreate.response,
        async (owner, commandId) =>
          withFleetAction(
            { owner, commandId, grant: admission.context },
            () => this.current(admission),
            () =>
              this.apply(
                owner,
                {
                  originalname: stage.input.body.file.name,
                  mimetype: stage.input.body.file.mime,
                  buffer: stage.bytes,
                },
                stage.input.body.options,
              ),
          ),
        "uploadCreate",
      );
      return this.signed(request, digest, receipt);
    } finally {
      this.pending--;
    }
  }
  receipt(input: unknown) {
    const request = fleetWorkspaceUploadApi.receipt.body.parse(input);
    const admission = this.authorize(request.credential);
    this.sweep();
    const prior = this.commands.receipt(
      admission.context,
      request.commandId,
      request.payloadDigest,
      "uploadCreate",
    );
    const stage = [...this.stages.values()].find(
      (item) => item.commandId === request.commandId,
    );
    // An active local transfer still owns its first commit. Another process's
    // retirement is safe too: commit checks the durable tombstone before IO.
    if (!prior && stage)
      this.match(stage, admission, request.commandId, request.payloadDigest);
    return this.signed(
      request,
      request.payloadDigest,
      prior ??
        (stage
          ? null
          : this.commands.reconcile(
              admission.context,
              request.commandId,
              request.payloadDigest,
              "uploadCreate",
            )),
    );
  }
  localReceipt(commandId: string, digest: string) {
    this.active();
    const receipt = this.commands.localReceipt(
      this.owner,
      commandId,
      digest,
      "uploadCreate",
      "files",
    );
    return receipt
      ? {
          ...receipt,
          result:
            receipt.result === null
              ? null
              : workspaceApi.uploadCreate.response.parse(receipt.result),
        }
      : { commandId, state: "unknown" as const, result: null };
  }
  get machineId() {
    return this.authority.identity.machineId;
  }
  close() {
    this.stopped = true;
    this.unobserve();
    this.clear();
  }
}
