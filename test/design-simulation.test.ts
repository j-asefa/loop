import type { WorkspaceEmission } from "../src/shared/workspace-events";
import { afterAll, expect, it, vi } from "vitest";
import express from "express";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { until } from "./helpers";

const home = mkdtempSync(join(tmpdir(), "loop-design-signals-"));
const data = join(home, "workspace"),
  manifest = join(home, "preview.json");
mkdirSync(data);
const marker = { schema: 1, previewId: randomUUID(), mode: "design" };
writeFileSync(join(data, "preview-owner.json"), JSON.stringify(marker));
writeFileSync(
  manifest,
  JSON.stringify({
    ...marker,
    name: "signals",
    home,
    build: {
      id: randomUUID(),
      branch: "fixture",
      commit: "a".repeat(40),
      dirty: false,
      builtAt: new Date().toISOString(),
      sourceHash: "b".repeat(64),
      artifactHash: "c".repeat(64),
    },
  }),
);
vi.stubEnv("LOOP_HOME", home);
vi.stubEnv("LOOP_DATA_DIR", data);
vi.stubEnv("LOOP_PREVIEW_MANIFEST", manifest);
const { db, changes } = await import("../src/server/db");
const { seedDesignPreview, startDesignSimulation, designPreviewBoundary } =
  await import("../src/server/design-preview");
const { core } = await import("../src/server/core-routes");
const app = express();
app.use(express.json(), (_req, res, next) => {
  res.locals.owner = "local-workspace";
  next();
});
app.use(designPreviewBoundary, core);
app.use((error: any, _req: any, res: any, _next: any) =>
  res.status(error.status || 500).json({ error: error.message }),
);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  changes.close();
  db.close();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

it.each([true, false])(
  "delivers simulated steering through the production route (bus=%s)",
  async (enabled) => {
    seedDesignPreview();
    const run = db
      .prepare("SELECT * FROM runs WHERE state='awaiting_approval' LIMIT 1")
      .get() as { id: string; agent_id: string; conversation_id: string };
    expect(run).toBeDefined();
    const bus = enabled
      ? undefined
      : vi.spyOn(changes, "subscribe").mockImplementation(() => () => {});
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const baseline = changes.subscriberCount;
    const stop = startDesignSimulation();
    try {
      const response = await fetch(
        `http://127.0.0.1:${(server.address() as any).port}/runs`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agentId: run.agent_id,
            conversationId: run.conversation_id,
            input: "Preview the signal",
            idempotencyKey: randomUUID(),
          }),
        },
      );
      expect(response.status).toBe(202);
      const body = await response.json();
      expect(body.steeringId).toBeTruthy();
      const state = () =>
        (
          db
            .prepare("SELECT state FROM run_steering WHERE id=?")
            .get(body.steeringId) as { state: string }
        ).state;
      if (!enabled) {
        expect(state()).toBe("pending");
        await vi.advanceTimersByTimeAsync(2000);
      }
      await until(() => state() === "delivered", 700);
      expect(
        db.prepare("SELECT state FROM runs WHERE id=?").get(run.id),
      ).toEqual({ state: "awaiting_approval" });
      expect(
        db
          .prepare(
            "SELECT count(*) n FROM messages WHERE run_id=? AND role='assistant' AND content LIKE '%Simulated reply%'",
          )
          .get(run.id),
      ).toEqual({ n: enabled ? 1 : 2 });
    } finally {
      await stop();
      expect(changes.subscriberCount).toBe(baseline);
      vi.useRealTimers();
      bus?.mockRestore();
    }
  },
);

it("completes an approved preview through claim and transition, preserving the preview event", async () => {
  seedDesignPreview();
  const approval = db
    .prepare("SELECT id,run_id FROM approvals WHERE state='pending' LIMIT 1")
    .get() as { id: string; run_id: string };
  // queue captured the original hook, so observe its durable request via the
  // completion event's producer, before asynchronous capture can clear it.
  const database = await import("../src/server/db");
  const emit = database.emit;
  const observed: string[] = [];
  const spy = vi
    .spyOn(database, "emit")
    .mockImplementation(
      (
        owner: string,
        run: Parameters<typeof emit>[1],
        ...event: WorkspaceEmission
      ) => {
        if (run === approval.run_id && event[0] === "completed") {
          expect(
            db
              .prepare(
                "SELECT capture_pending FROM run_checkouts WHERE run_id=?",
              )
              .get(run),
          ).toEqual({ capture_pending: 1 });
          observed.push("capture requested before completed");
        }
        return emit(owner, run, ...event);
      },
    );
  db.prepare(
    "INSERT INTO run_checkouts(id,owner_id,run_id,agent_id,conversation_id,directory,source,branch,start_head,start_dirty,start_untracked,started_at,state) VALUES(?,'local-workspace',?,'agent','conversation','','','','',0,0,0,'failed')",
  ).run(randomUUID(), approval.run_id);
  try {
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/approvals/${approval.id}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "approve" }),
      },
    );
    expect(response.status).toBe(200);
    expect(
      db
        .prepare("SELECT state,worker_id,heartbeat FROM runs WHERE id=?")
        .get(approval.run_id),
    ).toEqual({ state: "completed", worker_id: null, heartbeat: null });
    expect(
      db
        .prepare(
          "SELECT payload FROM events WHERE run_id=? AND type='completed'",
        )
        .all(approval.run_id),
    ).toEqual([{ payload: '{"preview":true}' }]);
    expect(observed).toEqual(["capture requested before completed"]);
  } finally {
    spy.mockRestore();
  }
});

it("rolls back preview output and approval when completion is refused", async () => {
  const { enqueue } = await import("../src/server/queue");
  const { requestApproval } = await import("../src/server/approvals");
  const queries = await import("../src/server/sql/runs");
  const sample = db
    .prepare(
      "SELECT agent_id,conversation_id FROM runs WHERE state='completed' LIMIT 1",
    )
    .get() as { agent_id: string; conversation_id: string };
  const run = enqueue(
    "local-workspace",
    "Refused preview completion",
    randomUUID(),
    { agent: sample.agent_id, conversation: sample.conversation_id },
  );
  db.prepare("UPDATE runs SET state='awaiting_approval' WHERE id=?").run(
    run.id,
  );
  const approval = requestApproval(run, { tool: "fixture" });
  const snapshot = () => ({
    run: db.prepare("SELECT * FROM runs WHERE id=?").get(run.id),
    approval: db.prepare("SELECT * FROM approvals WHERE id=?").get(approval.id),
    messages: db.prepare("SELECT * FROM messages WHERE run_id=?").all(run.id),
    events: db.prepare("SELECT * FROM events WHERE run_id=?").all(run.id),
    artifacts: db.prepare("SELECT * FROM artifacts WHERE run_id=?").all(run.id),
  });
  const prior = snapshot();
  const owned = queries.ownedState;
  const spy = vi
    .spyOn(queries, "ownedState")
    .mockImplementation((db, target, owner) => {
      const current = owned(db, target, owner);
      return target === run.id && current?.state === "running"
        ? { state: "cancelled" }
        : current;
    });
  try {
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/approvals/${approval.id}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "approve" }),
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "This preview run can no longer complete",
    });
    expect(snapshot()).toEqual(prior);
  } finally {
    spy.mockRestore();
  }
});
