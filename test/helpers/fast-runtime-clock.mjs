// Test-only: expose accidental 30-minute kill timers without a 30-minute test.
const schedule = globalThis.setTimeout;
globalThis.setTimeout = (callback, milliseconds, ...args) =>
  schedule(
    callback,
    milliseconds === 30 * 60 * 1000 ? 25 : milliseconds,
    ...args,
  );
const repeat = globalThis.setInterval;
globalThis.setInterval = (callback, milliseconds, ...args) =>
  repeat(callback, milliseconds === 15000 ? 25 : milliseconds, ...args);
