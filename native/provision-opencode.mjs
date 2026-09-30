/** Private host build. Never replaces a PATH executable or changes auth homes. */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stage } from "./build-opencode.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const pins = JSON.parse(
  readFileSync(join(packageRoot, "deployment/versions.json")),
);
export function buildIdentity() {
  const hash = createHash("sha256").update(JSON.stringify(pins));
  for (const name of [
    "build-opencode.mjs",
    "apply-opencode-patch.mjs",
    "opencode-execution-guard.ts",
    "opencode-models.json.gz",
  ])
    hash.update(readFileSync(join(packageRoot, "native", name)));
  return `${process.platform}-${process.arch}-${hash.digest("hex").slice(0, 24)}`;
}
export function cachedOpencode(root) {
  const identity = buildIdentity();
  const destination = join(resolve(root), "helpers", `opencode-${identity}`);
  const binary = join(
    destination,
    `source/packages/opencode/dist/opencode-${process.platform}-${process.arch}/bin/opencode`,
  );
  const marker = join(destination, "ready.json");
  if (!existsSync(marker) || !existsSync(binary)) return undefined;
  const record = JSON.parse(readFileSync(marker, "utf8"));
  const digest = createHash("sha256")
    .update(readFileSync(binary))
    .digest("hex");
  if (record.identity !== identity || record.sha256 !== digest)
    throw new Error(
      "Guarded OpenCode cache failed integrity verification; preserve it for diagnosis",
    );
  return binary;
}
export async function provisionOpencode(root, run = stage, bakedRoot) {
  // A configured image artifact must match this package. Never silently rebuild
  // a damaged or incompatible image into the user's persistent state.
  if (bakedRoot) {
    const baked = cachedOpencode(bakedRoot);
    if (!baked)
      throw new Error(
        "Baked guarded OpenCode artifact is missing or incompatible",
      );
    return baked;
  }
  if (!["linux", "darwin"].includes(process.platform))
    throw new Error(
      "Guarded OpenCode host provisioning currently requires Linux or macOS",
    );
  const identity = buildIdentity();
  const helpers = join(resolve(root), "helpers");
  const destination = join(helpers, `opencode-${identity}`);
  const relativeBinary = `source/packages/opencode/dist/opencode-${process.platform}-${process.arch}/bin/opencode`;
  const binary = join(destination, relativeBinary);
  const cached = cachedOpencode(root);
  if (cached) return cached;
  if (existsSync(destination))
    throw new Error(
      "Incomplete guarded OpenCode cache; preserve it for diagnosis and retry with a new Loop home",
    );
  mkdirSync(helpers, { recursive: true, mode: 0o700 });
  // Only a fully verified build is promoted; failures cannot poison a later retry.
  const temporary = mkdtempSync(join(helpers, "opencode-build-"));
  const source = join(temporary, "source");
  const tools = join(temporary, "tools");
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
    mkdirSync(source);
    await run("git", ["init", source], temporary, env, 30);
    await run(
      "git",
      ["remote", "add", "origin", "https://github.com/anomalyco/opencode.git"],
      source,
      env,
      30,
    );
    await run(
      "git",
      ["fetch", "--depth=1", "origin", pins.opencodeCommit],
      source,
      env,
      300,
    );
    await run("git", ["checkout", "--detach", "FETCH_HEAD"], source, env, 30);
    await run(
      "npm",
      [
        "install",
        "--prefix",
        tools,
        "--no-audit",
        "--no-fund",
        `bun@${pins.opencodeBun}`,
      ],
      temporary,
      env,
      1200,
    );
    await run(
      process.execPath,
      [
        join(packageRoot, "native/build-opencode.mjs"),
        source,
        join(tools, "node_modules/.bin/bun"),
      ],
      temporary,
      env,
      2400,
    );
    const built = join(temporary, relativeBinary);
    if (!existsSync(built))
      throw new Error("Guarded OpenCode build did not produce a host binary");
    await run(built, ["--version"], temporary, env, 30);
    writeFileSync(
      join(temporary, "ready.json"),
      JSON.stringify({
        identity,
        sha256: createHash("sha256").update(readFileSync(built)).digest("hex"),
      }),
      { mode: 0o600 },
    );
    // Source and MIT license remain alongside the modified binary for inspection.
    renameSync(temporary, destination);
    return binary;
  } finally {
    if (existsSync(temporary))
      rmSync(temporary, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.length !== 3) throw new Error("Expected LOOP_HOME");
  console.log(await provisionOpencode(process.argv[2]));
}
