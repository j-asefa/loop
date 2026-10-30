import "../runtime/environment.mjs";
// A real isolated MCP process through the broker; no model/provider credentials.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
const listener = createServer();
await new Promise((resolve, reject) => {
  listener.once("error", reject);
  listener.listen(0, "127.0.0.1", resolve);
});
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const data = mkdtempSync(join(tmpdir(), "loop55-mcp-smoke-"));
process.env.LOOP55_DATA_DIR = data;
process.env.LOOP55_RUNTIME_URL = "http://127.0.0.1:" + port;
process.env.LOOP55_RUNTIME_TOKEN = crypto.randomUUID() + crypto.randomUUID();
const broker = spawn(process.execPath, ["runtime/broker.ts"], {
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
broker.stdout.on("data", (b) => (logs += b));
broker.stderr.on("data", (b) => (logs += b));
const { RuntimeTransport } =
  await import("../src/server/mcp/runtime-transport.ts");
const { catalog } = await import("../src/server/mcp/catalog-data.ts");
const { catalogSecret } = await import("../src/server/mcp/catalog.ts");
const client = new Client({ name: "loop55-runtime-smoke", version: "1" });
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      if (
        (
          await fetch(process.env.LOOP55_RUNTIME_URL + "/health", {
            headers: {
              authorization: "Bearer " + process.env.LOOP55_RUNTIME_TOKEN,
            },
          })
        ).ok
      ) {
        ready = true;
        break;
      }
    } catch {}
    if (broker.exitCode !== null) throw new Error("Broker exited");
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(ready, "Broker ready");
  await client.connect(
    new RuntimeTransport(
      "smoke",
      catalogSecret(
        catalog.find((c) => c.id === "playwright"),
        {},
      ).stdio,
    ),
    { timeout: 90000 },
  );
  console.log("Connected to pinned Playwright catalog server");
  const tools = await client.listTools();
  console.log("Discovered " + tools.tools.length + " tools");
  assert.ok(tools.tools.some((t) => t.name === "browser_navigate"));
  const navigation = await client.callTool(
    { name: "browser_navigate", arguments: { url: "about:blank" } },
    undefined,
    { timeout: 30000 },
  );
  assert.ok(!navigation.isError, JSON.stringify(navigation));
  const tabs = await client.callTool({
    name: "browser_tabs",
    arguments: { action: "list" },
  });
  assert.ok(!tabs.isError, JSON.stringify(tabs));
  console.log(
    "PASS: pinned catalog Playwright starts in an isolated container, discovers " +
      tools.tools.length +
      " tools and controls bundled Chromium.",
  );
} catch (error) {
  console.error(logs.slice(-1500));
  throw error;
} finally {
  await client.close().catch(() => {});
  const closed = new Promise((r) => broker.once("close", r));
  broker.kill("SIGTERM");
  await closed;
  rmSync(data, { recursive: true, force: true });
}
