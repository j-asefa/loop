import { build } from "esbuild";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Package and container builds ship the same standalone JavaScript graph.
// Preserve module boundaries for sibling subprocesses and server imports.
export async function compileRuntime(root, output) {
  const directory = resolve(root, "runtime");
  const entryPoints = {};
  for (const file of await readdir(directory)) {
    // The checkout compatibility launcher delegates to host.ts; compiled hosts
    // use the TypeScript implementation directly, without a source dependency.
    if (file === "host.mjs") continue;
    if (!/\.(?:mjs|ts)$/.test(file) || /\.d\.ts$/.test(file)) continue;
    const name = file.replace(/\.(?:mjs|ts)$/, "");
    if (entryPoints[name]) throw new Error(`Duplicate runtime module: ${name}`);
    entryPoints[name] = join(directory, file);
  }
  await build({
    entryPoints,
    outdir: resolve(output),
    outExtension: { ".js": ".mjs" },
    platform: "node",
    format: "esm",
    target: "node22",
    bundle: true,
    packages: "external",
    plugins: [{
      name: "runtime-module-paths",
      setup(builder) {
        builder.onResolve({ filter: /^\.\.?\// }, ({ path }) => ({
          path: path.replace(/\.ts$/, ".mjs"),
          external: true,
        }));
      },
    }],
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error("Usage: compile-runtime.mjs <output-directory>");
  await compileRuntime(process.cwd(), process.argv[2]);
}
