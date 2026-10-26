import { agentWorktree } from "../src/server/agent-worktree.js";
import { gitProject } from "./git-project.js";
import { afterAll, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "loop-model-switch-")));
process.env.LOOP_DATA_DIR = dir;
gitProject(dir);
const { db, now } = await import("../src/server/db");
db.prepare(
  "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,created_at) VALUES('worktree-fixture','owner','Fixture','fixture','codex','fixture',0)",
).run();
const { enqueue, claim } = await import("../src/server/queue");
const { NativeSessions } = await import("../src/server/native-sessions");
const fixture = fileURLToPath(
  new URL("../test/fixtures/fake-acp.mjs", import.meta.url),
);

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

it("moves a native conversation to the agent's new harness with Loop's transcript", async () => {
  db.prepare("INSERT INTO harnesses VALUES('acp',?,'{}','{}','[]',0)").run(
    JSON.stringify({
      harness: "acp",
      executable: process.execPath,
      args: [fixture],
      project: dir,
    }),
  );
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES('native-acp','owner','acp','ACP','','connected','[]',?,0)",
  ).run(JSON.stringify({ loopHarness: "acp" }));
  db.prepare(
    "INSERT INTO conversations(id,owner_id,title,created_at) VALUES('switch','owner','t',0)",
  ).run();
  const checkout = agentWorktree(dir, dir, {
    ownerId: "owner",
    agentId: "worktree-fixture",
    environmentId: dir,
    projectId: dir,
  });
  db.prepare(
    "INSERT INTO companion_sessions(conversation_id,harness,native_id,project,model,instructions,updated_at,worktree_source,worktree_agent_id) VALUES('switch','codex','codex-thread',?,'gpt-old','Be brief.',0,?,'worktree-fixture')",
  ).run(checkout, dir);
  for (const [role, content] of [
    ["user", "Earlier question"],
    ["assistant", "Earlier answer"],
  ])
    db.prepare(
      "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,'owner','switch',NULL,?,?,'{}',?)",
    ).run(role + "-earlier", role, content, now());
  enqueue("owner", "Next question", "switch-run", {
    conversation: "switch",
    agent: "worktree-fixture",
    payload: {
      agentId: "worktree-fixture",
      name: "Fixture",
      provider: "acp",
      folderId: null,
      connectionId: "native-acp",
      model: "native-default",
      instructions: "Be brief.",
    },
  });
  const run = claim("w")!;
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES('current','owner','switch',?,'user','Next question','{}',?)",
  ).run(run.id, now());
  const sessions = new NativeSessions();
  const live = await sessions.session(run);
  try {
    const binding = db
      .prepare(
        "SELECT * FROM companion_sessions WHERE conversation_id='switch'",
      )
      .get() as any;
    expect(binding).toMatchObject({ harness: "acp", worktree_source: dir });
    expect(binding.project).toBe(checkout);
    expect(binding.native_id).not.toBe("codex-thread");
    expect(binding.instructions).toContain("Be brief.");
    expect(binding.instructions).toContain(
      JSON.stringify([
        { role: "user", content: "Earlier question" },
        { role: "assistant", content: "Earlier answer" },
      ]),
    );
    expect(binding.instructions).not.toContain("Next question");
  } finally {
    await sessions.dispose(live);
  }
});
