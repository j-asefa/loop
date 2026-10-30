import { monitorEventLoopDelay, performance } from "node:perf_hooks";

const histogram = monitorEventLoopDelay({ resolution: 10 });
let users = 0;
let started = 0;
let timer: ReturnType<typeof setInterval> | undefined;

/** API-process observation, including time before a request callback can run. */
export function eventLoopHealth() {
  const milliseconds = (value: number) =>
    Number.isFinite(value) ? Math.round(value / 1000) / 1000 : 0;
  return {
    observing: users > 0,
    windowMs: users ? Math.round(performance.now() - started) : 0,
    samples: histogram.count,
    meanMs: milliseconds(histogram.mean),
    p95Ms: milliseconds(histogram.percentile(95)),
    p99Ms: milliseconds(histogram.percentile(99)),
    maxMs: milliseconds(histogram.max),
  };
}

export function observeApiEventLoop() {
  if (++users === 1) {
    histogram.reset();
    started = performance.now();
    histogram.enable();
    timer = setInterval(() => {
      // The managed launcher's daemon log is also the source for `loop55 logs`.
      console.log(
        JSON.stringify({ diagnostic: "api-event-loop", ...eventLoopHealth() }),
      );
      histogram.reset();
      started = performance.now();
    }, 30_000);
    timer.unref();
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    if (--users === 0) {
      histogram.disable();
      clearInterval(timer);
    }
  };
}
