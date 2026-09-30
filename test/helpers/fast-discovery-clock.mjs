// Test-only: end the 20-second command discovery wait without a 20-second test.
const schedule = globalThis.setTimeout;
globalThis.setTimeout = (callback, milliseconds, ...args) =>
  schedule(callback, milliseconds === 20000 ? 250 : milliseconds, ...args);
