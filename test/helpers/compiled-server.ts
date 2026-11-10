import { globSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { BUILD_ASSETS } from "../../src/shared/build-assets.js";

/** Compile this checkout's server graph without using or replacing global dist. */
export async function compiledServerFixture() {
  const project = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "loop-compiled-events-"));
  const output = join(root, "dist");
  try {
    await mkdir(output);
    await symlink(resolve("node_modules"), join(root, "node_modules"), "dir");
    // Match the production graph's module-relative asset layout. The shared
    // staging compiler rewrites imports/resources into dist/support as usual.
    for (const { path: asset } of BUILD_ASSETS.filter((asset) =>
      asset.uses.includes("support"),
    ))
      await cp(join(project, asset), join(root, asset), {
        recursive: true,
        filter: (path) =>
          !relative(project, path)
            .split(sep)
            .some((part) => part === "node_modules" || part === ".git"),
      });
    await build({
      entryPoints: globSync("src/**/*.ts").filter(
        (path) => !path.startsWith("src/client/") && !path.endsWith(".d.ts"),
      ),
      outbase: "src",
      outdir: output,
      platform: "node",
      format: "esm",
      target: "node22",
      packages: "external",
      define: { __LOOP_BUILD__: "null" },
    });
    for (const file of ["pi-extension.mjs", "pi-auth-extension.mjs"])
      await cp(join(project, "src", file), join(output, file));
    const { stageRuntimeAssets } = await import(
      pathToFileURL(resolve("scripts/build-runtime-assets.mjs")).href
    );
    await stageRuntimeAssets(root, output);
    return {
      source: pathToFileURL(output + "/").href,
      close: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
