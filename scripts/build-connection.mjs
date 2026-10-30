// The connection service runs from one immutable, self-contained file, so an
// upgrade replacing the package never removes code it loads later. The
// companion's connection container ships the same file.
import { build } from "esbuild";
import { readFileSync } from "node:fs";
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
await build({
  entryPoints: ["src/connection-daemon.ts"],
  outfile: "dist/connection-daemon.bundle.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  define: { __LOOP55_RELEASE__: JSON.stringify(version) },
  banner: {
    js: 'import { createRequire as loop55Require } from "node:module"; const require = loop55Require(import.meta.url);',
  },
});
