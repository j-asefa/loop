import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { BUILD_ASSETS } from "../src/shared/build-assets.ts";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--write"))
  throw new Error("Use node scripts/package-files.mjs [--write]");
const path = new URL("../package.json", import.meta.url);
const manifest = JSON.parse(readFileSync(path, "utf8"));
const files = BUILD_ASSETS.filter((asset) =>
  asset.uses.includes("package"),
).map((asset) => asset.path);
if (args[0] === "--write") {
  manifest.files = files;
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
} else {
  assert.deepEqual(
    manifest.files,
    files,
    "package.json.files differs from BUILD_ASSETS; run node scripts/package-files.mjs --write",
  );
  console.log("Package files match the build asset manifest.");
}
