import assert from "node:assert/strict";
import express, { Router } from "express";
import { Problem } from "../../src/shared/problem.js";
import { listenForTest, productionApp } from "./app.js";

export async function verifyAppFixture() {
  const server = await listenForTest(express());
  try {
    assert.equal(server.listenerCount("error"), 0);
    assert.throws(
      () => server.emit("error", new Error("Late fixture failure")),
      /Late fixture failure/,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  const routes = Router();
  routes.get("/owner", (_req, res) => res.json({ owner: res.locals.owner }));
  routes.post("/payload", (req, res) => res.json(req.body));
  routes.get("/problem", () => {
    throw new Problem(409, "Fixture conflict");
  });
  const app = await productionApp("alice", [routes], {
    ownerHeader: "x-owner",
  });
  let closed = false;
  try {
    assert.deepEqual(await (await app.fetch("/api/owner")).json(), {
      owner: "alice",
    });
    assert.deepEqual(
      await (
        await app.fetch("/api/owner", { headers: { "x-owner": "bob" } })
      ).json(),
      { owner: "bob" },
    );
    assert.deepEqual(
      await (
        await app.fetch("/api/owner", { headers: { "x-owner": "" } })
      ).json(),
      { owner: "alice" },
    );
    assert.equal((await app.fetch("/owner")).status, 404);
    assert.deepEqual(
      await (
        await app.fetch("/api/payload", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ fixture: true }),
        })
      ).json(),
      { fixture: true },
    );
    const problem = await app.fetch("/api/problem");
    assert.equal(problem.status, 409);
    assert.deepEqual(await problem.json(), { error: "Fixture conflict" });
    const headerOnly = await productionApp(undefined, [routes], {
      ownerHeader: "x-owner",
      jsonLimit: "1mb",
    });
    try {
      assert.deepEqual(await (await headerOnly.fetch("/api/owner")).json(), {});
      assert.deepEqual(
        await (
          await headerOnly.fetch("/api/owner", { headers: { "x-owner": "" } })
        ).json(),
        { owner: "" },
      );
      assert.deepEqual(
        await (
          await headerOnly.fetch("/api/owner", {
            headers: { "x-owner": "bob" },
          })
        ).json(),
        { owner: "bob" },
      );
      const body = JSON.stringify({ fixture: "x".repeat(110 * 1024) });
      const request = {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      };
      const bounded = await app.fetch("/api/payload", request);
      assert.equal(bounded.status, 413);
      await bounded.arrayBuffer();
      const expanded = await headerOnly.fetch("/api/payload", request);
      assert.equal(expanded.status, 200);
      assert.deepEqual(await expanded.json(), JSON.parse(body));
    } finally {
      await headerOnly.close();
    }
    await app.close();
    closed = true;
    await assert.rejects(app.close(), { code: "ERR_SERVER_NOT_RUNNING" });
  } finally {
    if (!closed) await app.close();
  }
}
