import { globSync, readdirSync } from "node:fs";
import { build } from "esbuild";
import { cp, chmod, rm, writeFile } from "node:fs/promises";
import { readBuildStamp } from "./build-stamp.ts";
import { stageRuntimeAssets } from "./build-runtime-assets.mjs";
const stamp = readBuildStamp();
if (!stamp) throw new Error("Build stamp missing; run npm run build.");
// Clear old server code while preserving the freshly built UI.
for (const entry of readdirSync("dist")) {
  if (entry !== "web")
    await rm(`dist/${entry}`, { recursive: true, force: true });
}
// Preserve module-relative paths used by native fixtures, migration and host assets.
await build({
  entryPoints: globSync("src/**/*.ts").filter(
    (path) => !path.startsWith("src/client/") && !path.endsWith(".d.ts"),
  ),
  outbase: "src",
  outdir: "dist",
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  define: {
    __LOOP_BUILD__: JSON.stringify(stamp),
  },
});
await import("./build-connection.mjs");
await cp("src/pi-extension.mjs", "dist/pi-extension.mjs");
await cp("src/pi-auth-extension.mjs", "dist/pi-auth-extension.mjs");
await chmod("dist/cli.js", 0o755);
await writeFile("dist/build-id.json", JSON.stringify(stamp));
await stageRuntimeAssets(process.cwd(), "dist");

// Install the CLI with the same dependency graph validated by npm ci.
await cp("package-lock.json", "npm-shrinkwrap.json");
