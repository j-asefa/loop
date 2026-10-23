import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("host storage policy protects recovery points and active/user data", () => {
  const result = spawnSync("python3", [fileURLToPath(new URL("./storage-policy.py", import.meta.url))], {
    encoding: "utf8", timeout: 120000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
});
