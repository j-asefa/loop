import {
  CardSelectionSchema,
  compareCardOrder,
  type CardEntry,
  type CardSelection,
} from "./cards.js";
import type { CardReader } from "./card-client.js";

type ReadonlyValue<T> = T extends object
  ? { readonly [K in keyof T]: ReadonlyValue<T[K]> }
  : T;
export type CardSnapshot = ReadonlyValue<CardEntry>;
const frozenSnapshots = new WeakSet<object>();

function freezeSnapshot<T>(value: T): ReadonlyValue<T> {
  if (value && typeof value === "object" && !frozenSnapshots.has(value)) {
    Object.freeze(value);
    frozenSnapshots.add(value);
    for (const child of Object.values(value)) freezeSnapshot(child);
  }
  return value as ReadonlyValue<T>;
}

async function readWithBackoff<T>(
  read: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  for (;;) {
    signal?.throwIfAborted();
    try {
      return await read();
    } catch (error) {
      const { status, retryAfter } = (error || {}) as {
        status?: number;
        retryAfter?: number;
      };
      if (
        status !== 429 ||
        !retryAfter ||
        !Number.isFinite(retryAfter) ||
        retryAfter < 0
      )
        throw error;
      // Only a rate-limited read is retried. Keep the current page/watermark
      // and unpublished working set while honoring the server's retry delay.
      let remaining = retryAfter * 1000;
      while (remaining > 0) {
        const delay = Math.min(remaining, 2147483647);
        await new Promise<void>((resolve, reject) => {
          signal?.throwIfAborted();
          const done = () => {
            signal?.removeEventListener("abort", abort);
            resolve();
          };
          const timer = setTimeout(done, delay);
          const abort = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            reject(signal?.reason);
          };
          signal?.addEventListener("abort", abort, { once: true });
        });
        remaining -= delay;
      }
    }
  }
}

/** Full-collection synchronization, intentionally separate from a bounded UI
 * window. One instance belongs to one reader/source/credential and selection. */
export class CardCollection {
  private items = new Map<string, CardEntry>();
  private revision: string | null = null;
  private active: Promise<readonly CardSnapshot[]> | null = null;
  private activeSignal: AbortSignal | undefined;
  private readonly selection: CardSelection;
  constructor(
    private readonly reader: CardReader,
    selection: CardSelection,
  ) {
    this.selection = CardSelectionSchema.parse(selection);
    if (this.selection.q === "") delete this.selection.q;
  }
  sync(signal?: AbortSignal): Promise<readonly CardSnapshot[]> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.active) {
      if (signal !== this.activeSignal)
        return Promise.reject(
          new Error(
            "Concurrent collection sync calls must use the same AbortSignal",
          ),
        );
      return this.active;
    }
    const work = this.read(signal);
    this.active = work;
    this.activeSignal = signal;
    const finish = () => {
      if (this.active === work) {
        this.active = null;
        this.activeSignal = undefined;
      }
    };
    void work.then(finish, finish);
    return work;
  }
  private async read(signal?: AbortSignal) {
    // Publish atomically. A failed backfill or changes batch cannot leave an
    // apparently complete cache with an advanced watermark.
    const items = new Map(this.items);
    let revision = this.revision;
    try {
      if (revision === null) {
        const seen = new Set<string>();
        let before: string | undefined;
        do {
          const page = await readWithBackoff(
            () =>
              this.reader.list(
                { ...this.selection, limit: 100, before },
                signal,
              ),
            signal,
          );
          revision ??= page.revision; // Keep the FIRST page's watermark.
          for (const entry of page.items)
            items.set(entry.card.id, structuredClone(entry));
          before = page.next || undefined;
          if (before && seen.has(before))
            throw new Error("Cards pagination made no progress");
          if (before) seen.add(before);
        } while (before);
      }
      let more: boolean;
      do {
        const delta = await readWithBackoff(
          () =>
            this.reader.changes(
              { ...this.selection, after: revision! },
              signal,
            ),
          signal,
        );
        // Omitting `through` reconciles every eligible card, including edits to
        // old history and cards entering/leaving a project or search selection.
        for (const id of delta.removed) items.delete(id);
        for (const entry of delta.items)
          items.set(entry.card.id, structuredClone(entry));
        if (delta.more && delta.revision === revision)
          throw new Error("Cards changes made no progress");
        revision = delta.revision;
        more = delta.more;
      } while (more);
      signal?.throwIfAborted();
      // Cache entries and shared concurrent results cannot be mutated by a
      // consumer. Already frozen entries need no repeated deep traversal.
      const snapshot = freezeSnapshot(
        [...items.values()].sort((a, b) => compareCardOrder(b.order, a.order)),
      );
      this.items = items;
      this.revision = revision;
      return snapshot;
    } catch (error) {
      if ((error as { status?: number } | null | undefined)?.status === 409) {
        this.items.clear();
        this.revision = null;
      }
      throw error; // No automatic retry of denied credentials or missing filters.
    }
  }
}
