/** Shared laptop/image HAPI provisioning; keep independent of application imports. */
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { atomic, privateDir } from "./state.js";
const exec = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const versions = JSON.parse(
  readFileSync(join(packageRoot, "deployment/versions.json"), "utf8"),
);

async function run(command: string, args: string[], cwd = packageRoot) {
  await new Promise<void>((yes, no) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", shell: false });
    child.once("error", no);
    child.once("exit", (code) =>
      code === 0
        ? yes()
        : no(
            new Error(
              `${command} failed (${code}). Retry after resolving the setup error.`,
            ),
          ),
    );
  });
}
/** Build the exact already-reviewed HAPI patch on the laptop's architecture. */
export async function hapi(root: string) {
  const baked = process.env.LOOP_BAKED_HAPI;
  if (baked) root = baked;
  const patchHash = createHash("sha256")
    .update(readFileSync(join(packageRoot, "native/apply-hapi-patch.mjs")))
    .update(readFileSync(join(packageRoot, "native/loopManaged.ts")))
    .update(readFileSync(join(packageRoot, "native/command-results.ts")))
    .update(readFileSync(join(packageRoot, "native/pi-readiness.ts")))
    .update(
      readFileSync(join(packageRoot, "src/native-auth/pi-customizations.ts")),
    )
    .digest("hex")
    .slice(0, 12);
  const source = join(
    root,
    "helpers",
    `hapi-${versions.hapiCommit.slice(0, 8)}-${patchHash}`,
  );
  const target = `bun-${process.platform}-${process.arch}${process.platform === "linux" && process.arch === "x64" ? "-baseline" : ""}`;
  const binary = join(source, "cli", "dist-exe", target, "hapi");
  const ready = join(source, "loop-build-ready.json");
  if (existsSync(binary) && existsSync(ready)) return binary;
  if (baked) throw new Error("Baked HAPI artifact is missing or incompatible");
  console.log(
    `Preparing HAPI ${versions.hapi} for this machine (first launch only)…`,
  );
  privateDir(dirname(source));
  if (!existsSync(join(source, ".git")))
    await run("git", [
      "clone",
      "--filter=blob:none",
      "--no-checkout",
      "https://github.com/tiann/hapi.git",
      source,
    ]);
  await run("git", ["checkout", versions.hapiCommit], source);
  await run(process.execPath, [
    join(packageRoot, "native/apply-hapi-patch.mjs"),
    source,
  ]);
  // npm selects the Bun binary for the host; no Linux-only executable is copied.
  await run(
    "npx",
    [
      "--yes",
      "--package",
      `bun@${versions.bun}`,
      "bun",
      "install",
      "--frozen-lockfile",
    ],
    source,
  );
  await run(
    "npx",
    ["--yes", "--package", `bun@${versions.bun}`, "bun", "run", "build:exe"],
    join(source, "cli"),
  );
  if (!existsSync(binary))
    throw new Error("HAPI build did not produce the expected host binary");
  await exec(binary, ["--version"], { timeout: 10000 });
  atomic(ready, { patchHash });
  return binary;
}
