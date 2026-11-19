import { expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/server/search", async () =>
  (await import("./helpers/worker-mocks.js")).noSearchIndexing(),
);
vi.mock("../src/server/memory", async (original) =>
  (await import("./helpers/worker-mocks.js")).noMemoryCapture(original),
);

it("starts a worker on a populated database without replaying history into claim attempts", async () => {
  vi.resetModules();
  const directory = mkdtempSync(join(tmpdir(), "loop-worker-startup-"));
  vi.stubEnv("LOOP_DATA_DIR", directory);
  const prior = await import("../src/server/db");
  prior.db
    .prepare(
      "INSERT INTO runs(id,owner_id,input,state,idempotency_key,created_at,updated_at) VALUES('history','owner','old task','completed','history',1,1)",
    )
    .run();
  prior.db
    .transaction(() => {
      const insert = prior.db.prepare(
        "INSERT INTO events(owner_id,run_id,type,payload,created_at) VALUES('owner','history','completed','{}',1)",
      );
      for (let n = 0; n < 10000; n++) insert.run();
    })
    .immediate();
  prior.changes.close();
  prior.db.close();
  // Reopen as a fresh worker process would, preserving the durable history.
  vi.resetModules();
  const { db, changes, emit } = await import("../src/server/db");
  const { startWorker } = await import("../src/server/worker");
  const queue = await import("../src/server/queue");
  const claims = vi.spyOn(queue, "claim");
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const stop = startWorker();
  const delivered: string[] = [];
  const unsubscribe = changes.subscribe("owner", (events) =>
    delivered.push(...events.map((event) => event.type)),
  );
  try {
    emit("owner", "history", "attention.dismissed", {});
    await expect.poll(() => delivered).toEqual(["attention.dismissed"]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(claims).toHaveBeenCalledTimes(1);
  } finally {
    unsubscribe();
    await stop();
    changes.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
