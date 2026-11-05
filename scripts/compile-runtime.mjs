import { build } from "esbuild";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

// Package builds ship the server's runtime helpers as standalone JavaScript.
// Preserve module boundaries for server imports.
export async function compileRuntime(root, output) {
  const directory = resolve(root, "runtime");
  const entryPoints = {};
  for (const file of await readdir(directory)) {
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
    plugins: [
      {
        name: "runtime-module-paths",
        setup(builder) {
          builder.onResolve({ filter: /^\.\.?\// }, ({ path }) => ({
            path: path.replace(/\.ts$/, ".mjs"),
            external: true,
          }));
        },
      },
    ],
  });
}
