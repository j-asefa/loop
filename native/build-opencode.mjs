/** Build a guarded native binary from an explicit, task-owned source checkout.
 * Run: node native/build-opencode.mjs SOURCE ABSOLUTE_BUN_PATH [--skip-install]
 * Each stage is serial, bounded and cleans up its own process group.
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { auditedCommit } from "./apply-opencode-patch.mjs";

const pins = JSON.parse(
  readFileSync(new URL("../deployment/versions.json", import.meta.url)),
);
export function modelsSnapshot(compressed) {
  if (
    createHash("sha256").update(compressed).digest("hex") !==
    pins.opencodeModelsSha256
  )
    throw new Error("OpenCode model snapshot checksum mismatch");
  const bytes = gunzipSync(compressed);
  const data = JSON.parse(bytes);
  if (!data.openai?.models || !Object.keys(data.openai.models).length)
    throw new Error("OpenCode model snapshot has no OpenAI models");
  return bytes;
}
export async function stage(command, args, cwd, env, seconds = 1200) {
  await new Promise((yes, no) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: "inherit",
      detached: process.platform !== "win32",
    });
    let expired = false;
    let force;
    const kill = (signal) => {
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    };
    const stop = () => {
      expired = true;
      kill("SIGTERM");
      force ??= setTimeout(() => kill("SIGKILL"), 5000);
    };
    const timer = setTimeout(stop, seconds * 1000);
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(force);
      process.removeListener("SIGTERM", stop);
      process.removeListener("SIGINT", stop);
      if (child.pid) kill("SIGKILL");
    };
    child.once("error", (error) => {
      cleanup();
      no(error);
    });
    child.once("exit", (code) => {
      cleanup();
      code === 0 && !expired
        ? yes()
        : no(new Error("OpenCode build stage failed or timed out"));
    });
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [sourceArg, bunArg, option] = process.argv.slice(2);
  if (!sourceArg || !bunArg || (option && option !== "--skip-install"))
    throw new Error("Expected SOURCE BUN_PATH [--skip-install]");
  if (pins.opencodeCommit !== auditedCommit)
    throw new Error("OpenCode source pins disagree");
  const source = resolve(sourceArg),
    bun = resolve(bunArg);
  const snapshot = modelsSnapshot(
    readFileSync(new URL("./opencode-models.json.gz", import.meta.url)),
  );
  const temporary = mkdtempSync(join(tmpdir(), "loop-opencode-build-"));
  // Do not inherit release/upload flags, model URLs, preload hooks or package-manager overrides.
  const env = Object.fromEntries(
    [
      "PATH",
      "HOME",
      "USERPROFILE",
      "SystemRoot",
      "TMPDIR",
      "TEMP",
      "TMP",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
    ]
      .filter((k) => process.env[k])
      .map((k) => [k, process.env[k]]),
  );
  try {
    const snapshotPath = join(temporary, "models.json");
    writeFileSync(snapshotPath, snapshot, { mode: 0o600 });
    await stage(
      bun,
      [
        "-e",
        `if (Bun.version !== ${JSON.stringify(pins.opencodeBun)}) process.exit(1)`,
      ],
      source,
      env,
      30,
    );
    await stage(
      process.execPath,
      [
        fileURLToPath(new URL("./apply-opencode-patch.mjs", import.meta.url)),
        source,
      ],
      source,
      env,
      30,
    );
    if (option !== "--skip-install")
      await stage(
        bun,
        [
          "install",
          "--frozen-lockfile",
          "--ignore-scripts",
          "--network-concurrency=4",
          "--concurrent-scripts=1",
          "--filter",
          "opencode",
        ],
        source,
        env,
      );
    await stage(
      bun,
      [
        "run",
        "script/build.ts",
        "--single",
        "--skip-install",
        "--skip-embed-web-ui",
      ],
      join(source, "packages/opencode"),
      {
        ...env,
        OPENCODE_VERSION: pins.opencode,
        OPENCODE_CHANNEL: "latest",
        MODELS_DEV_API_JSON: snapshotPath,
        BUN_JSC_forceRAMSize: "536870912",
      },
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
