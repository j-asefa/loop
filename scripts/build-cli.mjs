import { globSync } from "node:fs";
import { build } from "esbuild";
import { cp, chmod } from "node:fs/promises";
// Preserve module-relative paths used by native fixtures, migration and host assets.
await build({
  entryPoints: globSync("src/**/*.ts").filter(path => !path.startsWith("src/client/") && !path.endsWith(".d.ts")),
  outbase: "src",
  outdir: "dist",
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
});
await cp("src/pi-extension.mjs", "dist/pi-extension.mjs");
await cp("dist/client", "dist/web", { recursive: true });
await chmod("dist/cli.js", 0o755);

// Install the CLI with the same dependency graph validated by npm ci.
await cp("package-lock.json", "npm-shrinkwrap.json");
