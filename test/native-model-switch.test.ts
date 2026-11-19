import {
  seedAgent,
  seedConnection,
  seedConversation,
  seedMessage,
} from "./helpers/seed.js";
import { testDirectory } from "./helpers/test-workspace.js";
import { prepareAgentWorkspace } from "../src/server/agent-worktree.js";
import { gitProject } from "./helpers/git-project.js";
import { afterAll, expect, it } from "vitest";
import { realpathSync } from "node:fs";

import { fileURLToPath } from "node:url";

const dir = realpathSync(testDirectory());

gitProject(dir);
const { db, now } = await import("../src/server/db");
seedAgent(db, {
  id: "worktree-fixture",
  owner_id: "owner",
  name: "Fixture",
  normalized_name: "fixture",
  provider: "codex",
  model: "fixture",
  created_at: 0,
});
const { enqueue, claim } = await import("../src/server/queue");
const { NativeSessions } = await import("../src/server/native-sessions");
const fixture = fileURLToPath(
  new URL("../test/fixtures/fake-acp.mjs", import.meta.url),
);

afterAll(() => {
  db.close();
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
  seedConnection(db, {
    id: "native-acp",
    owner_id: "owner",
    provider: "acp",
    label: "ACP",
    secret: "",
    models: "[]",
    metadata: JSON.stringify({ loopHarness: "acp" }),
    created_at: 0,
  });
  seedConversation(db, {
    id: "switch",
    owner_id: "owner",
    title: "t",
    created_at: 0,
  });
  const checkout = (
    await prepareAgentWorkspace(dir, dir, {
      ownerId: "owner",
      agentId: "worktree-fixture",
      environmentId: dir,
      projectId: dir,
    })
  ).directory;
  db.prepare(
    "INSERT INTO companion_sessions(conversation_id,harness,native_id,project,model,instructions,updated_at,worktree_source,worktree_agent_id) VALUES('switch','codex','codex-thread',?,'gpt-old','Be brief.',0,?,'worktree-fixture')",
  ).run(checkout, dir);
  for (const [role, content] of [
    ["user", "Earlier question"],
    ["assistant", "Earlier answer"],
  ] as const)
    seedMessage(db, {
      id: role + "-earlier",
      owner_id: "owner",
      conversation_id: "switch",
      run_id: null,
      role: role,
      content: content,
      metadata: "{}",
      created_at: now(),
    });
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
  seedMessage(db, {
    id: "current",
    owner_id: "owner",
    conversation_id: "switch",
    run_id: run.id,
    role: "user",
    content: "Next question",
    metadata: "{}",
    created_at: now(),
  });
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
