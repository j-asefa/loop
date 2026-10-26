import { withHeavySlot } from "./heavy-command.mjs";
import { cp, rm, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSource } from "./build-source.mjs";

const root = process.cwd();
const source = await buildSource(root);
let metadata;
try {
  // Only the image wrapper supplies this build-time input, from its immutable
  // context. Ordinary Git-less builds remain unknown. Never read it at runtime.
  if (process.env.LOOP_BUILD_SOURCE_FILE) {
    const identity = JSON.parse(
      await readFile(process.env.LOOP_BUILD_SOURCE_FILE, "utf8"),
    );
    if (
      !identity.clean ||
      identity.repository !== "github.com/j-asefa/loop" ||
      !/^[0-9a-f]{40}$/.test(identity.commit) ||
      !Array.isArray(identity.ancestors) ||
      identity.ancestors.length > 10000
    )
      throw new Error("Invalid source archive identity");
    source.stamp = identity;
  }
  metadata = await mkdtemp(join(tmpdir(), "loop-build-stamp-"));
  const stampFile = join(metadata, "stamp.json");
  await writeFile(stampFile, JSON.stringify(source.stamp));
  const env = { ...process.env, LOOP_BUILD_STAMP_FILE: stampFile };
  for (const args of [
    ["scripts/typecheck.mjs"],
    ["node_modules/vite/bin/vite.js", "build"],
    ["scripts/build-sw.mjs"],
    ["scripts/build-cli.mjs"],
  ]) {
    const status = await withHeavySlot(process.execPath, args, {
      label: `build ${args[0]}`,
      cwd: source.directory,
      env,
      stdio: "inherit",
    });
    if (status !== 0) {
      process.exitCode = status;
      console.error(`Build failed (${args[0]}, status ${status})`);
      break;
    }
  }
  if (!process.exitCode && source.directory !== root) {
    await rm(join(root, "dist"), { recursive: true, force: true });
    for (const file of [
      "dist",
      "native/command-results.js",
      "npm-shrinkwrap.json",
    ])
      await cp(join(source.directory, file), join(root, file), {
        recursive: true,
      });
  }
} finally {
  await source.cleanup();
  if (metadata) await rm(metadata, { recursive: true, force: true });
}
