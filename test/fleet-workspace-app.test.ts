import { expect, it, vi } from "vitest";
import express from "express";
import { setImmediate } from "node:timers/promises";
import { FleetWorkspaceApp } from "../src/server/fleet-workspace-app.js";
import { mountRoutes, registrar } from "../src/server/registrar.js";
import { workspaceApi } from "../src/shared/workspace-api.js";

const owner = "local-workspace";
function fixture() {
  const app = express();
  app.use(express.json());
  const routes = registrar("fleet-lifetime-fixture");
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = 0;
  let ready!: () => void;
  const fourStarted = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const wait = async () => {
    if (++started === 4) ready();
    await hold;
  };
  routes.on(
    workspaceApi.runAction,
    async (_input, res) => {
      await wait();
      res.json({ ok: true });
    },
    {
      tokenWrite: () => {
        throw new Error(
          "This lifecycle fixture accepts only session requests.",
        );
      },
    },
  );
  routes.on(workspaceApi.runs, async (_input, res) => {
    await wait();
    res.json([]);
  });
  mountRoutes(app, routes.mount, "/api");
  return { app, release, fourStarted, started: () => started };
}

for (const kind of ["action", "read"] as const)
  it(`retains ${kind} handler capacity after bridge deadlines until handlers finish`, async () => {
    const f = fixture();
    const bridge = new FleetWorkspaceApp(f.app, owner);
    const invoke = async () =>
      kind === "action"
        ? bridge.action(
            owner,
            {
              route: "runAction",
              params: { id: "fixture", action: "pause" },
              body: {},
            },
            () => {},
          )
        : bridge.read(
            owner,
            { route: "runs", params: {}, query: {} },
            () => {},
          );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const requests = Array.from({ length: 4 }, () =>
      invoke().catch((error) => error),
    );
    try {
      await f.fourStarted;
      await vi.advanceTimersByTimeAsync(12_000);
      for (const error of await Promise.all(requests))
        expect(error.status).toBe(504);
      const overflow = invoke().catch((error) => error);
      await vi.advanceTimersByTimeAsync(12_000);
      expect((await overflow).status).toBe(503);
      expect(f.started()).toBe(4);
      f.release();
      await setImmediate();
      await expect(invoke()).resolves.toHaveProperty("result");
      expect(f.started()).toBe(5);
    } finally {
      f.release();
      await Promise.all(requests);
      vi.useRealTimers();
    }
  });

it("refuses a handler reached after its request expired in middleware", async () => {
  const f = fixture();
  f.release();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const app = express();
  app.use(async (_req, _res, next) => {
    await held;
    next();
  });
  app.use(f.app);
  app.use(((error, _req, res, _next) => {
    if (!res.destroyed) res.status(error.status ?? 500).end();
  }) as express.ErrorRequestHandler);
  const bridge = new FleetWorkspaceApp(app, owner);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const result = bridge
      .action(
        owner,
        {
          route: "runAction",
          params: { id: "fixture", action: "pause" },
          body: {},
        },
        () => {},
      )
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(12_000);
    expect((await result).status).toBe(504);
    release();
    await setImmediate();
    expect(f.started()).toBe(0);
  } finally {
    release();
    vi.useRealTimers();
  }
});
