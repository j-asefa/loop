import { afterAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gitProject } from "./git-project";
import { until } from "./helpers";

const dir = mkdtempSync(join(tmpdir(), "loop-native-reply-contract-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_TEST_HARNESS = "codex";
gitProject(dir);
const { db } = await import("../src/server/db");
const { NativeSessions } = await import("../src/server/native-sessions");
const { OWNER } = await import("../src/server/workspace-identity");
const { createAgent, ownedRun } = await import("../src/server/domain");
const { enqueue, claim, transition } = await import("../src/server/queue");
const { saveSteering, activeRun } = await import("../src/server/steering");
const sessions = new NativeSessions();
afterAll(async () => {
  await sessions.close();
  db.close();
  delete process.env.LOOP_TEST_HARNESS;
  rmSync(dir, { recursive: true, force: true });
});

it("delivers Codex steering with the durable reply identity and publication instructions", async () => {
  await sessions.projects.enable({
    harness: "codex",
    executable: resolve("test/harness.mjs"),
    version: "0.157.0",
    project: dir,
    billing: "existing",
  });
  sessions.tools = () => ({ url: "http://127.0.0.1:9/mcp", token: "fixture" });
  const agent = createAgent(OWNER, {
    name: "codex-reply-contract",
    connectionId: "native-codex",
    model: "native-default",
    instructions: "",
  });
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES('codex-reply',?,?,'Reply contract',0)",
  ).run(OWNER, agent.id);
  const queued = enqueue(OWNER, "wait", "codex-reply", {
    conversation: "codex-reply",
    agent: agent.id,
    payload: {
      agentId: agent.id,
      name: agent.name,
      provider: "codex",
      folderId: null,
      connectionId: "native-codex",
      model: "native-default",
      // Keep the fixture's model observation stable while checking request identity.
      resolvedModel: "fixture",
      instructions: "",
    },
  });
  const run = claim(
    "reply-contract",
    (candidate) => candidate.id === queued.id,
  )!;
  const live = await sessions.session(run);
  const steer = vi.spyOn(live.adapter, "steer");
  const execution = sessions.execute(run);
  try {
    await until(
      () =>
        (
          db
            .prepare("SELECT state FROM native_dispatch WHERE run_id=?")
            .get(run.id) as any
        )?.state === "accepted",
    );
    const marker = ownedRun(run.id, OWNER).payload.nativeInput!;
    expect(marker).toEqual({
      runId: run.id,
      generation: live.generation,
      liveInput: true,
    });
    expect(activeRun(OWNER, run.conversation_id!)?.liveInput).toBe(true);
    expect(
      enqueue(OWNER, "wait", "codex-reply", {
        conversation: "codex-reply",
        agent: agent.id,
        payload: queued.payload,
      }).id,
    ).toBe(run.id);
    const next = enqueue(OWNER, "Next task", "codex-next", {
      conversation: "codex-reply",
      agent: agent.id,
      payload: ownedRun(run.id, OWNER).payload,
    });
    expect(next.payload.nativeInput).toBeUndefined();
    transition(next, "cancelled");
    for (const stale of [
      { ...marker, generation: "old-generation" },
      { ...marker, runId: "other-run" },
    ]) {
      db.prepare(
        "UPDATE runs SET payload=json_set(payload,'$.nativeInput',json(?)) WHERE id=?",
      ).run(JSON.stringify(stale), run.id);
      expect(activeRun(OWNER, run.conversation_id!)?.liveInput).toBe(false);
    }
    db.prepare(
      "UPDATE runs SET payload=json_set(payload,'$.nativeInput',json(?)) WHERE id=?",
    ).run(JSON.stringify(marker), run.id);
    const receipt = saveSteering(
      ownedRun(run.id, OWNER),
      "reply-contract",
      "reply-contract",
      "What did you find?",
      {},
    );
    const message = db
      .prepare("SELECT message_id FROM run_steering WHERE id=?")
      .get(receipt.steeringId) as { message_id: string };
    expect(await execution).toMatchObject({ kind: "finished" });
    expect(steer).toHaveBeenCalledTimes(1);
    const input = steer.mock.calls[0][0];
    expect(input).toContain(`Message ID: ${message.message_id}`);
    expect(input).toContain(`replyTo "${message.message_id}"`);
    expect(input).toContain("loop_reply");
    expect(input).toContain("What did you find?");
    expect(
      db
        .prepare("SELECT state FROM run_steering WHERE id=?")
        .get(receipt.steeringId),
    ).toEqual({ state: "delivered" });
  } finally {
    await sessions.interrupt(run.id);
    await execution;
    steer.mockRestore();
  }
});
