import { afterAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import express from "express";

// A multi-user server's installed-harness MCP configs hold the operator's
// credentials; no signed-in user may list or import them.
const dir = mkdtempSync(join(tmpdir(), "loop55-native-import-route-"));
process.env.LOOP55_DATA_DIR = dir;
process.env.LOOP55_ENCRYPTION_KEY = randomBytes(32).toString("hex");
process.env.LOOP55_PROFILE = "server";
process.env.LOOP55_AUTH_MODE = "multi-user";
const { db } = await import("../src/server/db");
const { mcp } = await import("../src/server/mcp/routes");

const app = express();
app.use(express.json(), (_req, res, next) => {
  res.locals.owner = "user-b";
  next();
});
app.use(mcp);
app.use((error: any, _req: any, res: any, _next: any) =>
  res.status(error.status || 500).json({ error: error.message }),
);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
afterAll(() => {
  server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

it("hides and refuses native MCP imports in multi-user mode", async () => {
  const listed = await fetch(base + "/mcp/native-candidates");
  expect(listed.status).toBe(200);
  expect(await listed.json()).toEqual([]);
  const imported = await fetch(base + "/mcp/native-candidates/any/import", {
    method: "POST",
  });
  expect(imported.status).toBe(403);
});
