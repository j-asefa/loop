import "../runtime/environment.mjs";
// Opt-in live discovery against public, no-account catalog servers. No tool calls.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
const data = mkdtempSync(join(tmpdir(), "loop55-catalog-live-"));
process.env.LOOP55_DATA_DIR = data;
process.env.LOOP55_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db } = await import("../src/server/db.ts");
const { catalog } = await import("../src/server/mcp/catalog-data.ts");
const { installCatalog } = await import("../src/server/mcp/catalog.ts");
try {
  const results = await Promise.all(
    catalog
      .filter((c) => c.auth === "none" && c.transport === "http")
      .map(async (c) => {
        const r = await installCatalog("live-smoke", c.id);
        console.log(c.name + ": " + r.status + ", " + r.tools + " tools");
        return { ...r, name: c.name };
      }),
  );
  for (const r of results) {
    assert.equal(r.status, "connected", r.name + " discovery failed");
    assert.ok(r.tools > 0, r.name + " returned no tools");
  }
  console.log(
    "PASS: live catalog discovery for " +
      results.length +
      " public providers. No account credentials or tool calls.",
  );
} finally {
  db.close();
  rmSync(data, { recursive: true, force: true });
}
