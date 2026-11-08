import { viewGeneration } from "./viewCache";

type Pending<T> = {
  source: string;
  controller: AbortController;
  reject: (error: unknown) => void;
  retrying: boolean;
  error?: unknown;
};

/** A source's cooldown must not hold the combined Feed or Needs refresh.
 * Report its first failure immediately, but keep one cancellable GET recovery.
 * Recovery requests a fresh head; a delayed page never installs stale state. */
export class FeedReadRecovery<T> {
  private pending = new Map<string, Pending<T>>();
  private generation = viewGeneration();

  reset(source?: string) {
    for (const [key, entry] of this.pending) {
      if (source !== undefined && source !== entry.source) continue;
      this.pending.delete(key);
      entry.controller.abort();
      entry.reject(new DOMException("Obsolete Feed read", "AbortError"));
    }
  }

  read(
    source: string,
    page: string,
    fetch: (
      signal: AbortSignal,
      onRetry: (error: unknown) => void,
    ) => Promise<T>,
    recovered: () => void,
  ): Promise<T> {
    if (this.generation !== viewGeneration()) {
      this.reset();
      this.generation = viewGeneration();
    }
    const generation = this.generation,
      key = JSON.stringify([source, page]);
    const prior = this.pending.get(key);
    // Further notifications retain the source's error while the same recovery
    // is running. They cannot multiply retry loops or wait behind that loop.
    if (prior?.retrying) return Promise.reject(prior.error);
    if (prior) {
      this.pending.delete(key);
      prior.controller.abort();
      prior.reject(new DOMException("Superseded Feed read", "AbortError"));
    }
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const delivery = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const entry: Pending<T> = {
      source,
      controller: new AbortController(),
      reject,
      retrying: false,
    };
    this.pending.set(key, entry);
    const current = () =>
      this.pending.get(key) === entry && generation === viewGeneration();
    void (async () => {
      try {
        const value = await fetch(entry.controller.signal, (error) => {
          if (!current()) {
            entry.controller.abort();
            throw new DOMException("Obsolete Feed read", "AbortError");
          }
          entry.retrying = true;
          entry.error = error;
          reject(error);
        });
        if (!current())
          throw new DOMException("Obsolete Feed read", "AbortError");
        this.pending.delete(key);
        entry.controller.abort();
        if (entry.retrying) recovered();
        else resolve(value);
      } catch (error) {
        // readRoute can retain shared recovery after retry exhaustion. The
        // view must still be able to cancel it before a manual retry or reset.
        if (current()) entry.retrying = false;
        else {
          if (this.pending.get(key) === entry) this.pending.delete(key);
          entry.controller.abort();
        }
        reject(error);
      }
    })();
    return delivery;
  }
}
