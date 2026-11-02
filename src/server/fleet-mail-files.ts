import * as fleetMailFilesQueries from "./sql/fleet-mail-files.js";
import * as fleetMailFileChunksQueries from "./sql/fleet-mail-file-chunks.js";
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { z } from "zod";
import type { FleetGrantContext } from "../shared/fleet.js";
import type { FleetMailEnvelope, FleetMailFile } from "../shared/fleet-mail.js";
import {
  FLEET_MAIL_FILE_CHUNK_BYTES,
  FLEET_MAIL_STAGING_BYTES,
  FLEET_MAIL_PEER_STAGING_BYTES,
  FleetMailFileChunk,
} from "../shared/fleet-mail-files.js";
import { Problem } from "../shared/problem.js";
import type { FleetMailJournal } from "./fleet-mail-journal.js";

type File = z.infer<typeof FleetMailFile>;
type Row = {
  reservation_id: string;
  descriptor: string;
  received: number;
  complete: number;
};
const conflict = () =>
  new Problem(409, "The prepared mail file is incomplete or changed.");

/** Bounded private copies belong to one prepared message, peer and local owner.
 * They are never browser artifacts or readable model attachments. Only the
 * existing mail-admission transaction may consume verified complete bytes. */
export class FleetMailFiles {
  constructor(
    private readonly db: Database.Database,
    private readonly journal: FleetMailJournal,
    private readonly owner: string,
    private readonly clock: () => number = Date.now,
  ) {}

  private key(envelope: FleetMailEnvelope, fileId: string) {
    return [
      this.owner,
      envelope.source.machineId,
      envelope.messageId,
      fileId,
    ] as const;
  }
  private row(envelope: FleetMailEnvelope, fileId: string) {
    return fleetMailFilesQueries.get(this.db, ...this.key(envelope, fileId)) as
      Row | undefined;
  }
  private chunks(envelope: FleetMailEnvelope, fileId: string) {
    return fleetMailFileChunksQueries.forFile(
      this.db,
      ...this.key(envelope, fileId),
    ) as { bytes: Buffer }[];
  }
  prune() {
    // Capacity is shared across every mapped owner on this receiving machine.
    fleetMailFilesQueries.prune(this.db, this.clock());
  }

  stage(context: FleetGrantContext, input: unknown) {
    const request = FleetMailFileChunk.parse(input);
    const bytes = Buffer.from(request.base64, "base64");
    if (bytes.toString("base64") !== request.base64)
      throw new Problem(400, "Invalid file chunk encoding.");
    const result = this.journal.withPrepared(
      context,
      request.envelope,
      request.reservationId,
      (envelope, expiresAt) => {
        const file = envelope.files.find(
          (file) => file.fileId === request.fileId,
        );
        if (
          !file ||
          request.offset % FLEET_MAIL_FILE_CHUNK_BYTES ||
          request.offset > file.bytes ||
          bytes.length !==
            Math.min(FLEET_MAIL_FILE_CHUNK_BYTES, file.bytes - request.offset)
        )
          throw conflict();
        this.prune();
        const key = this.key(envelope, file.fileId);
        let row = this.row(envelope, file.fileId);
        if (!row) {
          if (request.offset !== 0) throw conflict();
          const { size, peerSize } = fleetMailFilesQueries.reservedBytes(
            this.db,
            envelope.source.machineId,
          ) as {
            size: number;
            peerSize: number;
          };
          // Authenticate once in withPrepared; owner/grant aliases cannot reset
          // the machine identity's declared-byte allowance on this destination.
          if (peerSize + file.bytes > FLEET_MAIL_PEER_STAGING_BYTES)
            throw new Problem(429, "This peer's pending mail files are full.");
          if (size + file.bytes > FLEET_MAIL_STAGING_BYTES)
            throw new Problem(
              429,
              "This machine's pending mail files are full.",
            );
          fleetMailFilesQueries.insert(
            this.db,
            ...key,
            request.reservationId,
            JSON.stringify(file),
            file.bytes,
            expiresAt,
          );
          row = this.row(envelope, file.fileId)!;
        }
        if (
          row.reservation_id !== request.reservationId ||
          row.descriptor !== JSON.stringify(file)
        )
          throw conflict();
        const prior = fleetMailFileChunksQueries.get(
          this.db,
          ...key,
          request.offset,
        ) as { bytes: Buffer } | undefined;
        if (prior) {
          if (!prior.bytes.equals(bytes)) throw conflict();
          return {
            nextOffset: row.complete ? null : row.received,
            corrupt: false,
          };
        }
        if (row.complete || row.received !== request.offset) throw conflict();
        fleetMailFileChunksQueries.insert(
          this.db,
          ...key,
          request.offset,
          bytes,
        );
        const received = request.offset + bytes.length;
        if (received === file.bytes) {
          const hash = createHash("sha256");
          for (const chunk of this.chunks(envelope, file.fileId))
            hash.update(chunk.bytes);
          if (hash.digest("hex") !== file.digest) {
            fleetMailFilesQueries.remove(this.db, ...key);
            return { nextOffset: 0, corrupt: true };
          }
        }
        fleetMailFilesQueries.progress(
          this.db,
          received,
          received === file.bytes ? 1 : 0,
          ...key,
        );
        return {
          nextOffset: received === file.bytes ? null : received,
          corrupt: false,
        };
      },
    );
    if (result.corrupt) throw conflict();
    return { nextOffset: result.nextOffset };
  }

  /** The caller first applies recipient policy. Its synchronous copy callback
   * may only write the same database, so refusal rolls back copies with mail.
   * Bytes are materialized one file at a time, at most 25 MiB per callback. */
  consume<T>(
    context: FleetGrantContext,
    envelope: FleetMailEnvelope,
    reservationId: string,
    copy: (file: File, bytes: Buffer) => T,
  ): T[] {
    if (!this.db.inTransaction)
      throw new Error(
        "Mail files require the destination admission transaction",
      );
    return this.journal.withPrepared(
      context,
      envelope,
      reservationId,
      (value) => {
        // Validate the complete set before granting access to any file.
        for (const file of value.files) {
          const row = this.row(value, file.fileId);
          if (
            !row?.complete ||
            row.received !== file.bytes ||
            row.reservation_id !== reservationId ||
            row.descriptor !== JSON.stringify(file)
          )
            throw conflict();
        }
        const results: T[] = [];
        for (const file of value.files) {
          const bytes = Buffer.concat(
            this.chunks(value, file.fileId).map((chunk) => chunk.bytes),
          );
          if (
            bytes.length !== file.bytes ||
            createHash("sha256").update(bytes).digest("hex") !== file.digest
          )
            throw conflict();
          const result = copy(structuredClone(file), bytes);
          if (
            result &&
            typeof (result as { then?: unknown }).then === "function"
          )
            throw new Error("Mail file copies must finish inside admission");
          results.push(result);
        }
        fleetMailFilesQueries.removeMessage(
          this.db,
          this.owner,
          value.source.machineId,
          value.messageId,
        );
        return results;
      },
    );
  }
}
