import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
// One case per file: the mocked module graph owns one worker/database.
const { executeAgent } = vi.hoisted(() => ({ executeAgent: vi.fn() }));
vi.mock("../src/server/agent-runtime", async (original) => ({
  ...(await original<any>()),
  executeAgent,
}));
vi.mock("../src/server/search", () => ({ indexPending: async () => {} }));
vi.mock("../src/server/memory", async (original) => ({
  ...(await original<any>()),
  indexMemory: async () => {},
}));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it("tracks brief generation beside digests and aborts it before worker shutdown returns", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-brief-worker-"));
  vi.stubEnv("LOOP_PROFILE", "server");
  vi.stubEnv("LOOP_DATA_DIR", dir);
  vi.stubEnv("LOOP_ENCRYPTION_KEY", randomBytes(32).toString("hex"));
  const { db } = await import("../src/server/db");
  const { seal } = await import("../src/server/secrets");
  const { withTestAdapter } = await import("../src/server/providers");
  const { startWorker } = await import("../src/server/worker");
  db.prepare(
    "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES('p','owner','project','Project',0)",
  ).run();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES('c','owner','openai','Fixture',?,'connected','[{\"id\":\"fixture\"}]',0)",
  ).run(seal("fixture", "owner"));
  db.prepare(
    "INSERT INTO artifacts(id,owner_id,title,kind,content,folder_id,created_at,updated_at) VALUES('a','owner','Result','markdown','Ready','p',0,0)",
  ).run();
  db.prepare(
    "INSERT INTO brief_state(owner_id,project_id,connection_id,model,enabled,due_at) VALUES('owner','p','c','fixture',1,0)",
  ).run();
  let signal: AbortSignal | undefined,
    finished = false;
  const restore = withTestAdapter("openai", {
    models: async () => [],
    async *stream(_secret, input) {
      signal = input.signal;
      await new Promise<void>((resolve) =>
        signal!.addEventListener("abort", () => resolve(), { once: true }),
      );
      finished = true;
      signal.throwIfAborted();
    },
  });
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const stop = startWorker();
  try {
    await vi.advanceTimersByTimeAsync(60_000);
    expect(signal).toBeDefined();
    expect(
      db.prepare("SELECT generation_id FROM brief_state").get(),
    ).toMatchObject({ generation_id: expect.any(String) });
    await stop();
    expect(signal!.aborted).toBe(true);
    expect(finished).toBe(true);
    expect(
      db
        .prepare(
          "SELECT generation_id,current_version,due_at,last_error FROM brief_state",
        )
        .get(),
    ).toEqual({
      generation_id: null,
      current_version: 0,
      due_at: expect.any(Number),
      last_error: null,
    });
    expect(db.prepare("SELECT count(*) n FROM project_briefs").get()).toEqual({
      n: 0,
    });
  } finally {
    await stop();
    restore();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
