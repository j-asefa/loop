/** A source has at most one active read and one coalesced trailing read.
 * Other sources can publish and refresh while an earlier read is still slow. */
export function sourceReadQueue<T>(
  initial: string[],
  read: (source: string) => Promise<T>,
  current: () => boolean,
) {
  const queued = new Set(initial);
  const running = new Set<string>();
  const results = new Map<string, PromiseSettledResult<T>>();
  let finished = false;
  let resolve!: (results: Map<string, PromiseSettledResult<T>>) => void;
  const settled = new Promise<Map<string, PromiseSettledResult<T>>>((done) => {
    resolve = done;
  });
  function pump() {
    if (finished) return;
    if (!current()) queued.clear();
    for (const source of queued) {
      if (running.size >= 4) break;
      if (running.has(source)) continue;
      queued.delete(source);
      running.add(source);
      void Promise.resolve()
        .then(() => read(source))
        .then(
          (value) => {
            results.set(source, { status: "fulfilled", value });
          },
          (reason: unknown) => {
            results.set(source, { status: "rejected", reason });
          },
        )
        .finally(() => {
          running.delete(source);
          pump();
        });
    }
    if (!queued.size && !running.size) {
      finished = true;
      resolve(results);
    }
  }
  // Install the owner's invalidation callback before the first read starts.
  queueMicrotask(pump);
  return {
    settled,
    enqueue(sources: string[]) {
      if (finished || !current()) return false;
      for (const source of sources) queued.add(source);
      pump();
      return true;
    },
  };
}
