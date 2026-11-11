import { afterAll, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { registrar } from "../src/server/registrar";
import { errorHandler } from "../src/server/error-handler";
import { workspaceApi, workspaceRoutes } from "../src/shared/workspace-api";
import { Problem } from "../src/shared/problem";

const routes = registrar("registrar-test", {
  strict: true,
  caseSensitive: true,
});
const contract = {
  method: "POST",
  access: "session",
  path: "/input",
  params: z.object({}),
  query: z.object({}),
  status: 201,
  body: z.object({ label: z.string() }),
  response: z.object({ label: z.string() }),
} as const;
routes.on(contract, ({ body }, res) => {
  const projection = { ...body, privateColumn: "secret" };
  res.json(projection);
});
routes.on({ ...contract, path: "/bad-output" }, async (_input, res) => {
  await Promise.resolve();
  // @ts-expect-error Invalid outputs are also caught by the runtime projection.
  res.json({ label: 7, privateColumn: "secret" });
});
routes.on({ ...contract, path: "/async-error" }, async () => {
  throw new Problem(409, "Inspect first");
});
const app = express();
app.use(
  express.json(),
  (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.path === "/runs/fixture-run/reorder") {
      res.locals.owner = "registrar-owner";
      res.locals.bearer = { tokenId: "registrar-token", admission: ["write"] };
    }
    next();
  },
  routes.mount,
  errorHandler,
);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
async function post(path: string, body: unknown) {
  const response = await fetch(
    `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  return { status: response.status, body: await response.json() };
}

it("validates and projects through the registered HTTP handler", async () => {
  expect(await post("/input", { label: "public" })).toEqual({
    status: 201,
    body: { label: "public" },
  });
  expect(await post("/input", { label: 42 })).toEqual({
    status: 400,
    body: { error: expect.any(String) },
  });
  expect(await post("/bad-output", { label: "public" })).toEqual({
    status: 500,
    body: { error: "The workspace response is unavailable. Please try again." },
  });
  expect(await post("/async-error", { label: "public" })).toEqual({
    status: 409,
    body: { error: "Inspect first" },
  });
  for (const path of ["/Input", "/input/"]) {
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`,
      { method: "POST" },
    );
    expect(response.status).toBe(404);
  }
});

it("exposes only contract registration and mounting", () => {
  expect(Object.keys(registrar("memoryRoutes")).sort()).toEqual([
    "mount",
    "on",
  ]);
});

// These assertions are checked by the repository typecheck, never executed.
function registrationTypes() {
  // @ts-expect-error String registration is no longer part of the registrar.
  routes.legacy("POST /unlisted", () => {});
  // @ts-expect-error Importers can mount but cannot register on the raw router.
  routes.mount.get("/unlisted", () => {});
  // @ts-expect-error The mount has no Express registration surface.
  routes.mount.post("/unlisted", () => {});
}

void registrationTypes;

it("refuses an unregistered token mutation even when its operation name is known", () => {
  const unregistered = { ...workspaceApi.submit };
  expect(() =>
    routes.on(unregistered, () => {}, {
      tokenWrite: () => ({ status: 202, body: {} }),
    }),
  ).toThrow("registered identity");
});

it("passes the declared operation to replay policy after a registry key rename", async () => {
  const reorder = workspaceRoutes.runReorder;
  let operation: string | undefined;
  Reflect.deleteProperty(workspaceRoutes, "runReorder");
  Reflect.set(workspaceRoutes, "renamedReorder", reorder);
  try {
    routes.on(
      reorder,
      () => {
        throw new Error("A completed replay must not dispatch the effect");
      },
      {
        tokenWrite: (request) => {
          operation = request.operation;
          return { status: 200, body: { ok: true } };
        },
      },
    );
  } finally {
    Reflect.deleteProperty(workspaceRoutes, "renamedReorder");
    Reflect.set(workspaceRoutes, "runReorder", reorder);
  }
  expect(
    await post("/runs/fixture-run/reorder", {
      direction: "up",
      idempotencyKey: "stable-operation",
    }),
  ).toEqual({ status: 200, body: { ok: true } });
  expect(operation).toBe("runReorder");
});
