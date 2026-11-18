import { testDirectory } from "./helpers/test-workspace.js";
import { afterAll, expect, it } from "vitest";

import { fileURLToPath } from "node:url";
import { Acp } from "../src/adapters/acp";
import type { Live } from "../src/server/native-sessions";
import { seedConversation } from "./helpers/seed.js";

const dir = testDirectory();

const { db } = await import("../src/server/db");
const { enqueue, claim } = await import("../src/server/queue");
const { NativeSessions } = await import("../src/server/native-sessions");
const fixture = fileURLToPath(
  new URL("../test/fixtures/fake-acp.mjs", import.meta.url),
);

afterAll(() => {
  db.close();
});

it("persists only fixed guidance for ACP prompt and setting failures", async () => {
  seedConversation(db, {
    id: "acp-errors",
    owner_id: "owner",
    title: "t",
    created_at: 0,
  });
  db.prepare(
    "INSERT INTO companion_sessions(worktree_agent_id,conversation_id,harness,project,generation,updated_at) VALUES('fixture-agent','acp-errors','acp',?,'acp-generation',0)",
  ).run(dir);
  enqueue("owner", "t", "acp-bootstrap", { conversation: "acp-errors" });
  const bootstrap = claim("w")!;
  const sessions = new NativeSessions();
  const live: Live = sessions.state.attach({
    binding: {
      worktree_source: null,
      worktree_agent_id: "fixture-agent",
      conversation_id: "acp-errors",
      harness: "acp",
      native_id: null,
      project: dir,
      model: null,
      instructions: "",
      generation: "acp-generation",
      state: "idle",
    },
    adapter: (live) =>
      new Acp(
        {
          harness: "acp",
          executable: process.execPath,
          args: [fixture, "secret-errors"],
          project: dir,
          billing: "existing",
          version: "fake",
        },
        (event) => sessions.projector.event(live, event),
      ),
    generation: "acp-generation",
    ready: Promise.resolve(),
    bootstrapRun: bootstrap,
  });
  const adapter = live.adapter as Acp;
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
    sessions.state.startTurn(live, run);
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
