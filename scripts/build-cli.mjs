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
// The unbundled ACP adapter imports this portable helper from native/. Ship
// JavaScript beside the TypeScript source also copied into the HAPI runner.
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
await cp("dist/client", "dist/web", { recursive: true });
await chmod("dist/cli.js", 0o755);

// Install the CLI with the same dependency graph validated by npm ci.
await cp("package-lock.json", "npm-shrinkwrap.json");

// Ship one shared sign-in implementation for isolated native/Docker runners.
const { buildNativeAuth } = await import("./build-native-auth.mjs");
await buildNativeAuth();
