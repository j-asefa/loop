import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
export async function buildNativeAuth(
  outdir = resolve(root, "native/generated"),
) {
  await mkdir(outdir, { recursive: true });
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["src/native-auth/runner.ts"],
    outfile: join(outdir, "native-auth/service.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    metafile: true,
  });
  // The driver's extension path is relative to import.meta.url, including in
  // the artifact. Keep the same directory relationship as the source module.
  await cp(
    join(root, "src/pi-auth-extension.mjs"),
    join(outdir, "pi-auth-extension.mjs"),
  );
  await build({
    absWorkingDir: root,
    entryPoints: ["native/pi-managed-extension.ts"],
    outfile: join(outdir, "pi-managed-extension.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
  });
  await build({
    absWorkingDir: root,
    entryPoints: ["src/native-auth/pi-customizations.ts"],
    outfile: join(outdir, "pi-customizations.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
  });
  await build({
    absWorkingDir: root,
    entryPoints: ["src/harness-upgrades.ts"],
    outfile: join(outdir, "harness-upgrades.mjs"),
    bundle: true, platform: "node", format: "esm", target: "node22",
  });
  return result.metafile;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await buildNativeAuth(process.argv[2] && resolve(process.argv[2]));
