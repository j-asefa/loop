await import("../tests/helpers/install");
const { tick, execute } = await import("../src/server/worker");
const { db, now } = await import("../src/server/db");
setInterval(
  () =>
    db
      .prepare("INSERT OR REPLACE INTO worker_health VALUES('fixture',?)")
      .run(now()),
  200,
);
let busy = false;
setInterval(() => {
  if (busy) return;
  busy = true;
  void tick(async (run) => {
    try {
      return await execute(run);
    } catch (error) {
      // These entrypoints use fixture data only; preserve the underlying failure for CI.
      console.error("Fixture execution failed", error);
      throw error;
    }
  }).finally(() => (busy = false));
}, 100);
