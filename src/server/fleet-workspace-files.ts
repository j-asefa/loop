import * as profileQueries from "./sql/deployment-profile.js";
import * as runsQueries from "./sql/runs.js";
import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import type { FleetGrantContext } from "../shared/fleet.js";
import { Problem } from "../shared/problem.js";
import {
  FleetFileMetadata,
  FleetFileOpened,
  FleetFileChunk,
  FleetFileClosed,
  fleetWorkspaceFileApi,
  FLEET_FILE_BYTES,
  FLEET_FILE_CHUNK_BYTES,
  type FleetFileSelection,
} from "../shared/fleet-workspace-file-api.js";
import { directoryDigest, fleetPayloadDigest } from "./fleet-crypto.js";
import { FleetProof } from "./fleet-proof.js";
import type { FleetAuthority } from "./fleet-authority.js";
import type { FleetCredentials } from "./fleet-credentials.js";
import type { FleetWorkspaceApp } from "./fleet-workspace-app.js";

type Admission = { context: FleetGrantContext; directory: string };
type Snapshot = Admission & {
  selection: FleetFileSelection;
  file: FleetFileMetadata;
  bytes: Buffer;
  expires: number;
  idle: number;
  dispose: () => void;
};

/** On-demand workspace downloads, separate from an agent's published-file mail
 * grants. Opening uses the existing owning HTTP projection. At most two bounded
 * snapshots survive for 30 idle seconds / 120 total seconds; no file URL, path,
 * browser cookie or native context can select a transfer. */
export class FleetWorkspaceFiles {
  private readonly proof: FleetProof;
  private readonly snapshots = new Map<string, Snapshot>();
  private pending = 0;
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private readonly unobserve: () => void;
  constructor(
    private readonly db: Database.Database,
    private readonly authority: FleetAuthority,
    private readonly credentials: FleetCredentials,
    private readonly owner: string,
    private readonly app: FleetWorkspaceApp,
    secrets: ConstructorParameters<typeof FleetProof>[2],
    private readonly now: () => number = () => performance.now(),
  ) {
    this.proof = new FleetProof(db, authority.identity, secrets);
    this.unobserve = authority.observe(owner, () => this.clear());
  }
  private clear() {
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const entry of this.snapshots.values()) entry.dispose();
    this.snapshots.clear();
  }
  private drop(id: string) {
    this.snapshots.get(id)?.dispose();
    this.snapshots.delete(id);
  }
  private sweep() {
    const now = this.now();
    for (const [id, entry] of this.snapshots)
      if (entry.expires <= now || entry.idle <= now) this.drop(id);
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.snapshots.size) {
      const next = Math.min(
        ...[...this.snapshots.values()].map((entry) =>
          Math.min(entry.expires, entry.idle),
        ),
      );
      this.timer = setTimeout(() => this.sweep(), Math.max(1, next - now));
      this.timer.unref();
    }
  }
  private authorize(credential: string): Admission {
    if (
      this.stopped ||
      (profileQueries.current(this.db) as { profile: string } | undefined)
        ?.profile !== "companion"
    )
      throw new Problem(403, "This workspace does not admit fleet files.");
    const accepted = this.credentials.authenticate(credential);
    if (accepted.owner !== this.owner || accepted.context.operation !== "files")
      throw new Problem(403, "This credential cannot read workspace files.");
    const directory = this.authority.directory(this.owner);
    if (!directory)
      throw new Problem(403, "The fleet directory is unavailable.");
    return {
      context: accepted.context,
      directory: directoryDigest(directory.document),
    };
  }
  private current(credential: string, admission: Admission) {
    const next = this.authorize(credential);
    if (
      next.directory !== admission.directory ||
      next.context.grantId !== admission.context.grantId ||
      next.context.peer !== admission.context.peer
    )
      throw new Problem(409, "File permissions changed. Open the file again.");
  }
  private resource(selection: FleetFileSelection, admission: Admission) {
    if (selection.route === "agentTracesExport")
      this.authority.acceptedGrant(
        this.owner,
        admission.context.peer,
        admission.context.fleetId,
        admission.context.grantId,
        "read",
      );
    const id = selection.params.id;
    const row =
      selection.route === "objectFile"
        ? this.db
            .prepare(
              "SELECT length(bytes) size FROM objects WHERE id=? AND owner_id=?",
            )
            .get(id, this.owner)
        : selection.route === "artifactFile"
          ? this.db
              .prepare(
                "SELECT f.size FROM artifacts a JOIN artifact_objects f ON f.artifact_id=a.id AND f.owner_id=a.owner_id WHERE a.id=? AND a.owner_id=?",
              )
              .get(id, this.owner)
          : runsQueries.agentFileAccess(
              this.db,
              id,
              selection.query.run ?? "",
              this.owner,
            );
    if (!row) throw new Problem(404, "The workspace file is unavailable.");
    const size = (row as { size: number }).size;
    if (!Number.isSafeInteger(size) || size < 0 || size > FLEET_FILE_BYTES)
      throw new Problem(413, "This file exceeds the fleet transfer limit.");
  }
  private identity(
    requestId: string,
    request: Record<string, unknown>,
    admission: Admission,
    transferId: string,
  ) {
    return {
      version: 1 as const,
      requestId,
      requestDigest: fleetPayloadDigest({ requestId, ...request }),
      machineId: this.authority.identity.machineId,
      peer: admission.context.peer,
      grantId: admission.context.grantId,
      directory: admission.directory,
      transferId,
    };
  }
  async open(input: unknown, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const request = fleetWorkspaceFileApi.open.body.parse(input);
    const admission = this.authorize(request.credential);
    this.sweep();
    if (this.snapshots.size + this.pending >= 2)
      throw new Problem(
        503,
        "File transfers are busy. Finish a download and try again.",
      );
    this.resource(request.selection, admission);
    this.pending++;
    const current = () => {
      signal?.throwIfAborted();
      this.current(request.credential, admission);
      this.resource(request.selection, admission);
    };
    try {
      const value = await this.app.file(
        this.owner,
        request.selection,
        current,
        signal,
      );
      current();
      const file = FleetFileMetadata.parse({
        size: value.bytes.length,
        checksum: createHash("sha256").update(value.bytes).digest("hex"),
        mediaType: value.mediaType,
        disposition: value.disposition,
      });
      const transferId = randomUUID(),
        now = this.now();
      const abort = () => {
        this.drop(transferId);
        this.sweep();
      };
      this.snapshots.set(transferId, {
        ...admission,
        selection: request.selection,
        file,
        bytes: value.bytes,
        expires: now + 120_000,
        idle: now + 30_000,
        dispose: () => signal?.removeEventListener("abort", abort),
      });
      signal?.addEventListener("abort", abort, { once: true });
      this.sweep();
      const response = FleetFileOpened.parse({
        ...this.identity(
          request.requestId,
          { selection: request.selection },
          admission,
          transferId,
        ),
        file,
        chunkBytes: FLEET_FILE_CHUNK_BYTES,
      });
      return {
        response,
        signature: this.proof.sign("workspace-file-open", response),
      };
    } finally {
      this.pending--;
    }
  }
  private snapshot(transferId: string, admission: Admission) {
    this.sweep();
    const entry = this.snapshots.get(transferId);
    if (
      !entry ||
      entry.context.peer !== admission.context.peer ||
      entry.context.grantId !== admission.context.grantId ||
      entry.context.fleetId !== admission.context.fleetId ||
      entry.directory !== admission.directory
    )
      throw new Problem(
        404,
        "The file transfer expired or is unavailable. Open the file again.",
      );
    try {
      this.resource(entry.selection, admission);
    } catch (error) {
      this.drop(transferId);
      this.sweep();
      throw error;
    }
    return entry;
  }
  chunk(input: unknown) {
    const request = fleetWorkspaceFileApi.chunk.body.parse(input),
      admission = this.authorize(request.credential);
    const entry = this.snapshot(request.transferId, admission);
    if (
      request.offset > entry.file.size ||
      (request.offset === entry.file.size && entry.file.size !== 0)
    )
      throw new Problem(416, "Choose an offset within this file.");
    const end = Math.min(
      entry.file.size,
      request.offset + FLEET_FILE_CHUNK_BYTES,
    );
    const response = FleetFileChunk.parse({
      ...this.identity(
        request.requestId,
        { transferId: request.transferId, offset: request.offset },
        admission,
        request.transferId,
      ),
      checksum: entry.file.checksum,
      offset: request.offset,
      nextOffset: end < entry.file.size ? end : null,
      base64: entry.bytes.subarray(request.offset, end).toString("base64"),
    });
    this.current(request.credential, admission);
    entry.idle = this.now() + 30_000;
    this.sweep();
    return {
      response,
      signature: this.proof.sign("workspace-file-chunk", response),
    };
  }
  release(input: unknown) {
    const request = fleetWorkspaceFileApi.close.body.parse(input),
      admission = this.authorize(request.credential);
    this.sweep();
    if (this.snapshots.has(request.transferId)) {
      this.snapshot(request.transferId, admission);
      this.drop(request.transferId);
    }
    this.sweep();
    const response = FleetFileClosed.parse({
      ...this.identity(
        request.requestId,
        { transferId: request.transferId },
        admission,
        request.transferId,
      ),
      closed: true,
    });
    return {
      response,
      signature: this.proof.sign("workspace-file-close", response),
    };
  }
  close() {
    this.stopped = true;
    this.unobserve();
    this.clear();
  }
}
