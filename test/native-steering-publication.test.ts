import { testDirectory } from "./helpers/test-workspace.js";
import { afterAll, expect, it, vi } from "vitest";

import { resolve } from "node:path";
import { gitProject } from "./helpers/git-project.js";
import { until } from "./helpers/wait.js";
import { seedConversation } from "./helpers/seed.js";

const dir = testDirectory();

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
});

it.each(["wait", "async-question-finish"])(
  "delivers Codex steering with durable reply identity and publication instructions after %s",
  async (prompt) => {
    const conversation = "codex-reply-" + prompt;
    await sessions.projects.enable({
      harness: "codex",
      executable: resolve("test/harness.mjs"),
      version: "0.157.0",
      project: dir,
      billing: "existing",
    });
    sessions.tools = () => ({
      url: "http://127.0.0.1:9/mcp",
      token: "fixture",
    });
    const agent = createAgent(OWNER, {
      name: "reply-" + prompt,
      connectionId: "native-codex",
      model: "native-default",
      instructions: "",
    });
    seedConversation(db, {
      id: conversation,
      owner_id: OWNER,
      agent_id: agent.id,
      title: "Reply contract",
      created_at: 0,
    });
    const queued = enqueue(OWNER, prompt, conversation, {
      conversation,
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
        enqueue(OWNER, prompt, conversation, {
          conversation,
          agent: agent.id,
          payload: queued.payload,
        }).id,
      ).toBe(run.id);
      const next = enqueue(OWNER, "Next task", conversation + "-next", {
        conversation,
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
      if (prompt === "async-question-finish") {
        await until(
          () => ownedRun(run.id, OWNER).state === "awaiting_approval",
        );
        // Codex has completed native work, but its async question keeps the
        // same Loop run and dispatch active so a free-text reply can continue it.
        await until(() => (live.adapter as any).turn === "");
        expect(live.requests.size).toBe(1);
        expect(activeRun(OWNER, conversation)?.liveInput).toBe(true);
        expect(
          db
            .prepare(
              "SELECT state FROM companion_sessions WHERE conversation_id=?",
            )
            .get(conversation),
        ).toEqual({ state: "running" });
      }
      const receipt = saveSteering(
        ownedRun(run.id, OWNER),
        conversation,
        conversation,
        "What did you find?",
        {},
      );
      const message = db
        .prepare("SELECT message_id FROM run_steering WHERE id=?")
        .get(receipt.steeringId) as { message_id: string };
      if (prompt === "async-question-finish") {
        await until(
          () =>
            (
              db
                .prepare("SELECT state FROM run_steering WHERE id=?")
                .get(receipt.steeringId) as { state: string }
            ).state === "delivered",
        );
        await until(() => (live.adapter as any).turn === "");
        // The free-text reply does not silently answer a pending question.
        const decision = db
          .prepare("SELECT id,state FROM native_decisions WHERE run_id=?")
          .get(run.id) as { id: string; state: string };
        expect(decision.state).toBe("pending");
        await sessions.decisions.answer(decision.id, "answer-after-reply", {
          "0": ["Wait for active agents"],
        });
      }
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
  },
);
