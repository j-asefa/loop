// Keep the baked launcher's directory layout without shipping build dependencies.
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

export function stageHapiArtifact(buildRoot, binary, destination) {
  const source = resolve(dirname(binary), "../../..");
  const sourcePath = relative(resolve(buildRoot), source);
  if (!sourcePath || sourcePath.startsWith("..") || resolve(buildRoot, sourcePath) !== source)
    throw new Error("HAPI artifact must belong to the helper build directory");
  const stagedSource = join(destination, sourcePath);
  const stagedBinary = join(destination, relative(buildRoot, binary));
  mkdirSync(dirname(stagedBinary), { recursive: true });
  copyFileSync(binary, stagedBinary);
  copyFileSync(join(source, "loop-build-ready.json"), join(stagedSource, "loop-build-ready.json"));
  copyFileSync(join(source, "LICENSE"), join(stagedSource, "LICENSE"));
  copyFileSync(join(source, "cli/NOTICE"), join(stagedSource, "NOTICE"));
  // Archive the patched working sources, including new managed modules, for
  // redistribution. Git's file list excludes .git and ignored build outputs.
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: source });
  execFileSync("tar", ["--null", "-T", "-", "-czf", join(stagedSource, "hapi-source.tar.gz")], { cwd: source, input: files });
  return stagedBinary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { hapi } = await import("../dist/hapi-build.js");
  const buildRoot = "/opt/loop-hapi";
  stageHapiArtifact(buildRoot, await hapi(buildRoot), "/opt/loop-hapi-artifact");
  // Remove build inputs in the same Docker layer that downloaded them.
  rmSync(buildRoot, { recursive: true, force: true });
}
