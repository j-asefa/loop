import { z } from "zod";
import { RunDisplayState } from "./run-state.js";

const Count = z.number().int().nonnegative().safe();
export const ProjectedMessage = z.object({
  id: z.string(),
  owner_id: z.string(),
  conversation_id: z.string(),
  run_id: z.string().nullable(),
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string(),
  metadata: z.string(),
  // Imported timestamps are finite milliseconds, including fractional values.
  created_at: z.number().finite(),
  revision: Count,
  cursor: z.tuple([Count, Count, Count]),
  run_state: RunDisplayState.nullable().optional(),
  run_error: z.string().nullable().optional(),
  run_checkout: z.string().nullable().optional(),
  run_verification: z.string().nullable().optional(),
});
export type ProjectedMessage = z.infer<typeof ProjectedMessage>;
type TranscriptRange = {
  from: ProjectedMessage["cursor"];
  before: ProjectedMessage["cursor"];
};
const comparePosition = (
  a: ProjectedMessage["cursor"],
  b: ProjectedMessage["cursor"],
) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
export const MessageAppend = z.strictObject({
  messageId: z.string(),
  conversationId: z.string(),
  revision: Count,
  baseRevision: Count,
  offset: Count,
  chunkIndex: Count,
  text: z.string(),
});
export const MessageRemoval = z.strictObject({
  messageId: z.string(),
  conversationId: z.string(),
  revision: Count,
});
export type TranscriptEvent =
  | { type: "message.upsert"; payload: { message: ProjectedMessage } }
  | { type: "message.delta"; payload: z.infer<typeof MessageAppend> }
  | { type: "message.remove"; payload: z.infer<typeof MessageRemoval> };

/** Display-only projection. A byte-offset mismatch asks for a fresh snapshot;
 * it never guesses an append or performs an action on the user's behalf. */
export class TranscriptProjection {
  readonly messages = new Map<string, ProjectedMessage>();
  readonly revisions = new Map<string, number>();
  private chunks = new Set<string>();
  private observed = new Map<string, number>();
  private removed = new Map<string, number>();
  private ranges: TranscriptRange[] = [];
  install(
    messages: readonly ProjectedMessage[],
    cursor?: number,
    range?: TranscriptRange,
    exposeRange = true,
  ) {
    if (range && exposeRange) {
      const sorted = [...this.ranges, range].sort((a, b) =>
        comparePosition(a.from, b.from),
      );
      this.ranges = [];
      for (const next of sorted) {
        const previous = this.ranges.at(-1);
        if (previous && comparePosition(previous.before, next.from) >= 0)
          previous.before =
            comparePosition(previous.before, next.before) >= 0
              ? previous.before
              : next.before;
        else this.ranges.push({ ...next });
      }
    }
    for (const message of messages) {
      if (message.revision < (this.revisions.get(message.id) ?? -1)) continue;
      if (
        cursor !== undefined &&
        ((this.observed.get(message.id) ?? -1) > cursor ||
          ((this.removed.get(message.id) ?? -1) >= cursor &&
            message.revision <= (this.revisions.get(message.id) ?? -1)))
      )
        continue;
      this.messages.set(message.id, message);
      this.revisions.set(message.id, message.revision);
      this.removed.delete(message.id);
      if (cursor !== undefined) this.observed.set(message.id, cursor);
    }
    if (cursor !== undefined && range) {
      const present = new Set(messages.map((message) => message.id));
      for (const [id, message] of this.messages) {
        if (
          present.has(id) ||
          (this.observed.get(id) ?? -1) > cursor ||
          comparePosition(message.cursor, range.from) < 0 ||
          comparePosition(message.cursor, range.before) >= 0
        )
          continue;
        this.messages.delete(id);
        this.removed.set(id, cursor);
        this.observed.set(id, cursor);
      }
    }
  }
  apply(id: number, event: TranscriptEvent): "applied" | "duplicate" | "gap" {
    const messageId =
      event.type === "message.upsert"
        ? event.payload.message.id
        : event.payload.messageId;
    if (id <= (this.observed.get(messageId) ?? -1)) return "duplicate";
    if (event.type === "message.upsert") {
      const message = event.payload.message;
      if (message.revision <= (this.revisions.get(message.id) ?? -1))
        return "duplicate";
      this.install([message]);
      this.observed.set(message.id, id);
      return "applied";
    }
    if (event.type === "message.remove") {
      const p = event.payload;
      if (p.revision <= (this.revisions.get(p.messageId) ?? -1))
        return "duplicate";
      this.revisions.set(p.messageId, p.revision);
      this.messages.delete(p.messageId);
      this.observed.set(p.messageId, id);
      this.removed.set(p.messageId, id);
      return "applied";
    }
    const p = event.payload;
    const key = `${id}:${p.chunkIndex}`;
    const message = this.messages.get(p.messageId);
    if (
      this.chunks.has(key) ||
      (this.revisions.get(p.messageId) ?? -1) > p.revision
    )
      return "duplicate";
    const bytes = message && new TextEncoder().encode(message.content).length;
    // A snapshot at this revision already includes every chunk in its atomic
    // batch. Offset distinguishes that case from an incomplete live revision.
    if (message?.revision === p.revision && bytes! > p.offset)
      return "duplicate";
    if (!message || message.revision !== p.baseRevision || bytes !== p.offset)
      return "gap";
    this.messages.set(message.id, {
      ...message,
      content: message.content + p.text,
      revision: p.revision,
    });
    this.revisions.set(message.id, p.revision);
    this.observed.set(message.id, id);
    this.chunks.add(key);
    if (this.chunks.size > 4096)
      this.chunks.delete(this.chunks.values().next().value!);
    return "applied";
  }
  /** An anchored snapshot ends before the live tail. A newer observed row
   * asks the caller for that page; older unseen rows remain hidden. */
  needsLatest() {
    const end = this.ranges.at(-1)?.before;
    return (
      !!end &&
      [...this.messages.values()].some(
        (message) => comparePosition(message.cursor, end) >= 0,
      )
    );
  }
  rows() {
    return [...this.messages.values()]
      .filter(
        (message) =>
          !this.ranges.length ||
          this.ranges.some(
            (range) =>
              comparePosition(message.cursor, range.from) >= 0 &&
              comparePosition(message.cursor, range.before) < 0,
          ),
      )
      .sort(
        (a, b) =>
          a.cursor[0] - b.cursor[0] ||
          a.cursor[1] - b.cursor[1] ||
          a.cursor[2] - b.cursor[2],
      );
  }
}

type Buffered = { id: number; event: TranscriptEvent };
type Ticket = {
  generation: number;
  events: Buffered[];
  bytes: number;
  overflow: boolean;
};
/** One instance belongs to one source/owner/conversation. Each page request has
 * its own watermark: a newest-page snapshot cannot acknowledge older pages. */
export class TranscriptHandoff {
  projection = new TranscriptProjection();
  ready = false;
  private generation = 0;
  private pending = new Set<Ticket>();
  private floor = 0;
  private coveredThrough = Infinity;
  epoch = "";
  /** The first socket reset can arrive on either side of the initial HTTP
   * response. Reuse that response only if it covers the reset watermark. */
  connect(epoch: string, cursor: number) {
    if (this.epoch === epoch && this.ready && this.coveredThrough >= cursor)
      return false;
    if (!this.epoch && !this.ready && this.pending.size) {
      this.epoch = epoch;
      this.floor = cursor;
      return false;
    }
    this.reset(epoch);
    this.floor = cursor;
    return true;
  }
  reset(epoch: string) {
    this.ready = false;
    this.epoch = epoch;
    this.generation++;
    this.pending.clear();
    this.floor = 0;
    this.coveredThrough = Infinity;
    this.projection = new TranscriptProjection();
  }
  begin(): Ticket {
    const ticket: Ticket = {
      generation: this.generation,
      events: [],
      bytes: 0,
      overflow: false,
    };
    this.pending.add(ticket);
    return ticket;
  }
  cancel(ticket: Ticket) {
    this.pending.delete(ticket);
  }
  receive(id: number, event: TranscriptEvent) {
    for (const ticket of this.pending) {
      ticket.bytes += JSON.stringify(event).length;
      if (ticket.events.length >= 512 || ticket.bytes > 4 * 1024 * 1024) {
        ticket.overflow = true;
        ticket.events = [];
      } else if (!ticket.overflow) ticket.events.push({ id, event });
    }
    return this.projection.apply(id, event);
  }
  install(
    ticket: Ticket,
    snapshot: { epoch: string; cursor: number },
    rows: ProjectedMessage[],
    range?: TranscriptRange,
    exposeRange = true,
  ) {
    this.pending.delete(ticket);
    if (
      ticket.generation !== this.generation ||
      ticket.overflow ||
      snapshot.cursor < this.floor ||
      (this.epoch && this.epoch !== snapshot.epoch)
    )
      return false;
    this.epoch = snapshot.epoch;
    this.projection.install(rows, snapshot.cursor, range, exposeRange);
    const ids = new Set(rows.map((row) => row.id));
    for (const entry of ticket.events) {
      const id =
        entry.event.type === "message.upsert"
          ? entry.event.payload.message.id
          : entry.event.payload.messageId;
      if (
        (entry.id > snapshot.cursor || !ids.has(id)) &&
        this.projection.apply(entry.id, entry.event) === "gap" &&
        ids.has(id)
      )
        return false;
      // receive() already reports gaps to the caller's recovery queue. A gap
      // outside this fetched page must not prevent that page from hydrating;
      // otherwise an anchored open retries forever while its live tail streams.
    }
    this.ready = true;
    this.coveredThrough = Math.min(this.coveredThrough, snapshot.cursor);
    return true;
  }
}
