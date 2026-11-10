// The connection service runs from one immutable, self-contained file, so an
// upgrade replacing the package never removes code it loads later. The
// companion's connection container ships the same file.
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { readBuildStamp } from "./build-stamp.ts";
import { runningBuild } from "../src/shared/build.ts";
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
await build({
  entryPoints: ["src/connection-daemon.ts"],
  outfile: "dist/connection-daemon.bundle.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  define: {
    __LOOP_BUILD__: JSON.stringify(
      readBuildStamp() ?? { ...runningBuild, release: version },
    ),
  },
  banner: {
    js: 'import { createRequire as loopRequire } from "node:module"; const require = loopRequire(import.meta.url);',
  },
});
