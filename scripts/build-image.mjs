// Supply Docker with the exact source snapshot whose identity we recorded.
// A plain docker build remains supported, with unknown source provenance.
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildSource } from "./build-source.mjs";
const source = await buildSource(process.cwd());
try {
  const args = ["build", ...process.argv.slice(2)];
  if (source.stamp.clean) {
    await writeFile(
      join(source.directory, ".loop-build-source.json"),
      JSON.stringify(source.stamp),
    );
    args.push("--build-arg", "LOOP_BUILD_SOURCE_FILE=.loop-build-source.json");
  }
  const result = spawnSync("docker", [...args, source.directory], {
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error("Docker build failed");
} finally {
  await source.cleanup();
}
