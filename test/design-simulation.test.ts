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
vi.stubEnv("LOOP_PROFILE", "companion");
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
