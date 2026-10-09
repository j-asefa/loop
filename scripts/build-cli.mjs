import { globSync, readdirSync } from "node:fs";
import { build } from "esbuild";
import { cp, chmod, rm } from "node:fs/promises";
// Clear old server code while preserving the freshly built UI.
for (const entry of readdirSync("dist")) {
  if (entry !== "client") await rm(`dist/${entry}`, { recursive: true, force: true });
}
// Older builds emitted runner bundles here; nothing loads them now.
await rm("native/generated", {recursive:true,force:true});
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
// The unbundled ACP adapter imports this portable helper from native/. Ship
// JavaScript beside the TypeScript source.
await build({
  entryPoints: ["native/command-results.ts"],
  outdir: "native",
  platform: "node",
  format: "esm",
  target: "node22",
});
await import("./build-connection.mjs");
await cp("src/pi-extension.mjs", "dist/pi-extension.mjs");
await cp("src/pi-auth-extension.mjs", "dist/pi-auth-extension.mjs");
// Remove stale hashed assets before copying the current UI into the package.
await rm("dist/web", { recursive: true, force: true });
await cp("dist/client", "dist/web", { recursive: true });
await chmod("dist/cli.js", 0o755);

// Install the CLI with the same dependency graph validated by npm ci.
await cp("package-lock.json", "npm-shrinkwrap.json");
