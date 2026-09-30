import { afterAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Acp } from "../src/adapters/acp";
import { NativeOutput } from "../src/server/native-output";
import type { Live } from "../src/server/native-sessions";

const dir = mkdtempSync(join(tmpdir(), "loop-acp-errors-"));
process.env.LOOP_DATA_DIR = dir;
const { db } = await import("../src/server/db");
const { enqueue, claim } = await import("../src/server/queue");
const { NativeSessions } = await import("../src/server/native-sessions");
const fixture = fileURLToPath(
  new URL("../test/fixtures/fake-acp.mjs", import.meta.url),
);

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

it("persists only fixed guidance for ACP prompt and setting failures", async () => {
  db.prepare(
    "INSERT INTO conversations(id,owner_id,title,created_at) VALUES('acp-errors','owner','t',0)",
  ).run();
  db.prepare(
    "INSERT INTO companion_sessions(conversation_id,harness,project,generation,updated_at) VALUES('acp-errors','acp',?,'acp-generation',0)",
  ).run(dir);
  enqueue("owner", "t", "acp-bootstrap", { conversation: "acp-errors" });
  const bootstrap = claim("w")!;
  const sessions = new NativeSessions();
  const live: Live = {
    binding: {
      conversation_id: "acp-errors",
      harness: "acp",
      native_id: null,
      project: dir,
      model: null,
      instructions: "",
      generation: "acp-generation",
      state: "idle",
    },
    adapter: undefined as unknown as Acp,
    generation: "acp-generation",
    ready: Promise.resolve(),
    bootstrapRun: bootstrap,
    requests: new Map(),
    cancelling: false,
    waiting: false,
    bridgeWaiting: 0,
    items: new NativeOutput(),
    closed: false,
  };
  const adapter = new Acp(
    {
      harness: "acp",
      executable: process.execPath,
      args: [fixture, "secret-errors"],
      project: dir,
      billing: "existing",
      version: "fake",
    },
    (event) => sessions.event(live, event),
  );
  live.adapter = adapter;
  (sessions as any).live.set("acp-errors", live);
  try {
    await adapter.start();
    await expect(
      sessions.setSetting(
        "acp-errors",
        "level",
        "deep",
        adapter.settings.revision,
        live.generation,
      ),
    ).rejects.toThrow(/refresh settings and retry/);

    const settings = db
      .prepare(
        "SELECT record FROM agent_activities WHERE conversation_id=? AND kind='settings'",
      )
      .get("acp-errors") as { record: string };
    expect(settings.record).toContain("refresh settings and retry");
    expect(settings.record).not.toContain("secret-setting-token");

    enqueue("owner", "t", "acp-prompt", { conversation: "acp-errors" });
    const run = claim("w")!;
    live.run = run;
    await adapter.prompt("hello");
    const deadline = Date.now() + 3000;
    while (
      !(
        db.prepare("SELECT error FROM runs WHERE id=?").get(run.id) as {
          error: string | null;
        }
      ).error &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 10));

    const stored = db
      .prepare("SELECT error FROM runs WHERE id=?")
      .get(run.id) as { error: string | null };
    const events = db
      .prepare("SELECT payload FROM events WHERE run_id=?")
      .all(run.id) as { payload: string }[];
    expect(stored.error).toContain("Check the agent's local login and logs");
    expect(JSON.stringify({ stored, events, settings })).not.toContain(
      "secret-",
    );
  } finally {
    await adapter.dispose();
  }
});
