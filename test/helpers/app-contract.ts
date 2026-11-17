import assert from "node:assert/strict";
import { Router } from "express";
import { Problem } from "../../src/shared/problem.js";
import { productionApp } from "./app.js";

export async function verifyAppFixture() {
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
    await app.close();
    closed = true;
    await assert.rejects(app.close(), { code: "ERR_SERVER_NOT_RUNNING" });
  } finally {
    if (!closed) await app.close();
  }
}
