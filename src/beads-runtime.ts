import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { access, chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const beadsRelease = "1.3.4";

// Archive digests from the upstream checksums.txt and executable digests
// computed from the corresponding verified archives.
const builds: Record<string, [string, string, string, string]> = {
  "linux-x64": [
    "linux_amd64",
    "bd",
    "175c26904bde3ff9168d2282ff6b56f17b17f60c22fa5acb3dacc9fb3465303a",
    "9185e9798ba044b288e781f7d57f28a48f558654e94572473e49991826e69930",
  ],
  "linux-arm64": [
    "linux_arm64",
    "bd",
    "f4ee6eb3ec79bb2d7eb9d717c73efbcb6fa763cc70f726b4d055b72afdd68ad5",
    "dbc0ea57d30947deaaa0c53269f4e40b66a045a2c457b66f5cd111751d86ea20",
  ],
  "darwin-x64": [
    "darwin_amd64",
    "./bd",
    "05e713a2da8eeaba40b924184735d9a34d2da8669e4d3ac50cc716605ba10640",
    "b98484a3b99745ffc042d87b48ffd457696d50e6bab64ef181aa033dcdcf2473",
  ],
  "darwin-arm64": [
    "darwin_arm64",
    "./bd",
    "b08a9c15bff80c42235f32946f94a6566a7d90944fe8afe45f3fd2f350596cdb",
    "e657e1f04aedcb4188d923d49cda1f3477aba94175eaae8c4c611fbb04f6fdb7",
  ],
};

async function digest(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function extract(archive: string, entry: string, destination: string) {
  const child = spawn("tar", ["-xOzf", archive, entry], {
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 60_000,
    killSignal: "SIGKILL",
  });
  const exited = new Promise<void>((done, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? done() : reject(new Error("Could not extract Beads")),
    );
  });
  await Promise.all([
    pipeline(child.stdout, createWriteStream(destination, { mode: 0o700 })),
    exited,
  ]);
}

const installations = new Map<string, Promise<string>>();
const verified = new Map<string, { binary: string; stamp: string }>();

async function executableStamp(binary: string) {
  const info = await stat(binary, { bigint: true }).catch(() => undefined);
  if (!info?.isFile()) return undefined;
  try {
    await access(binary, constants.X_OK);
  } catch {
    return undefined;
  }
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
}

/** Resolve the pinned desktop or preinstalled companion executable. */
export function beadsBinary(root: string): Promise<string> {
  const path = resolve(root, "beads-runtime", beadsRelease, "bd");
  const active = installations.get(path);
  if (active) return active;
  const installing = verifyOrInstall(path);
  installations.set(path, installing);
  void installing.then(
    () => installations.delete(path),
    () => installations.delete(path),
  );
  return installing;
}

async function verifyOrInstall(path: string) {
  const previous = verified.get(path);
  if (previous && (await executableStamp(previous.binary)) === previous.stamp)
    return previous.binary;
  const binary = await install(path);
  const stamp = await executableStamp(binary);
  const expected = builds[`${process.platform}-${process.arch}`]![3];
  if (
    !stamp ||
    (await digest(binary)) !== expected ||
    (await executableStamp(binary)) !== stamp
  )
    throw new Error("Beads executable changed during verification");
  verified.set(path, { binary, stamp });
  return binary;
}

async function publishBinary(
  path: string,
  verifiedStaging: string,
  expected: string,
) {
  await exec(
    "python3",
    ["-I", lock, "--install", verifiedStaging, path, expected],
    {
      cwd: resolve(path, ".."),
      timeout: 30_000,
      killSignal: "SIGKILL",
      maxBuffer: 2048,
    },
  );
}

async function install(path: string) {
  const build = builds[`${process.platform}-${process.arch}`];
  if (!build) throw new Error("Beads requires macOS or Linux on x64 or arm64");
  const [platform, entry, archiveHash, executableHash] = build;
  if ((await digest(path).catch(() => undefined)) === executableHash) {
    if (!(await executableStamp(path)))
      await publishBinary(path, "", executableHash);
    return path;
  }
  const baked =
    process.env.LOOP_BAKED_BEADS &&
    resolve(process.env.LOOP_BAKED_BEADS, "beads-runtime", beadsRelease, "bd");
  if (
    baked &&
    (await executableStamp(baked)) &&
    (await digest(baked).catch(() => undefined)) === executableHash
  )
    return baked;

  const dir = resolve(path, "..");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(dir, "download-"));
  const archive = join(staging, "beads.tar.gz");
  const binary = join(staging, "bd");
  try {
    const asset = `beads_${beadsRelease}_${platform}.tar.gz`;
    const response = await fetch(
      `https://github.com/gastownhall/beads/releases/download/v${beadsRelease}/${asset}`,
      { signal: AbortSignal.timeout(120_000) },
    );
    if (!response.ok || !response.body)
      throw new Error("Beads download failed");
    const hash = createHash("sha256");
    let size = 0;
    await pipeline(
      Readable.from(response.body),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          if (size > 80 * 1024 * 1024)
            return callback(new Error("Beads download exceeds limit"));
          hash.update(chunk);
          callback(null, chunk);
        },
      }),
      createWriteStream(archive, { mode: 0o600 }),
    );
    if (hash.digest("hex") !== archiveHash)
      throw new Error("Beads archive integrity check failed");
    await extract(archive, entry, binary);
    if ((await digest(binary)) !== executableHash)
      throw new Error("Beads executable integrity check failed");
    await chmod(binary, 0o700);
    await publishBinary(path, binary, executableHash);
    return path;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

const lock = fileURLToPath(
  new URL("../deployment/beads-locked.py", import.meta.url),
);

export type BeadsScope = {
  ownerId: string;
  profile: string;
  projectId: string;
};

/** Stable across checkout moves, renames and temporary worktrees. */
export function beadsStoreId(scope: BeadsScope) {
  return createHash("sha256")
    .update(JSON.stringify([scope.ownerId, scope.profile, scope.projectId]))
    .digest("hex");
}

export class BeadsUnavailable extends Error {
  constructor(options?: ErrorOptions) {
    super("Project Work is unavailable on the owning companion.", options);
  }
}

/** A failed call or lost response can arrive after a mutation committed. */
export class BeadsWriteUnknown extends Error {
  constructor(options?: ErrorOptions) {
    super("The Beads write may have committed.", options);
  }
}

/** Installer or launcher failed before the executable could mutate its store. */
export class BeadsNotStarted extends BeadsUnavailable {}

export class BeadsPreconditionFailed extends Error {
  constructor() {
    super("The bead changed before this request could be applied.");
  }
}

type BeadsGuard =
  | { ready: string }
  | { current: { id: string; status: string; assignee: string | null } };

export class BeadsStore {
  readonly id: string;
  private readonly directory: string;

  constructor(
    private readonly root: string,
    scope: BeadsScope,
  ) {
    this.id = beadsStoreId(scope);
    this.directory = resolve(root, "beads-stores", this.id);
  }

  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.execute([
      "init",
      "--prefix",
      "loop",
      "--non-interactive",
      "--skip-agents",
      "--skip-hooks",
      "--init-if-missing",
    ]);
    // Check the store actually opens, including after an interrupted init.
    await this.read(["list", "--limit", "1"]);
  }

  async read(args: readonly string[]): Promise<unknown> {
    return this.json(["--readonly", ...args]);
  }

  async write(args: readonly string[], guard?: BeadsGuard): Promise<unknown> {
    try {
      return JSON.parse(await this.execute(args, guard)) as unknown;
    } catch (error) {
      if (error instanceof BeadsNotStarted) throw error;
      const reason = error instanceof BeadsUnavailable ? error.cause : error;
      // Pinned bd update uses exit 13 for a failed compare-and-set, as does
      // the lock wrapper when the authoritative ready query loses its guard.
      if (
        typeof reason === "object" &&
        reason !== null &&
        "code" in reason &&
        reason.code === 13
      )
        throw new BeadsPreconditionFailed();
      // The caller owns the durable receipt and must inspect Beads for its
      // operation identity before doing anything with an uncertain write.
      throw new BeadsWriteUnknown({ cause: reason });
    }
  }

  private async json(args: readonly string[]): Promise<unknown> {
    try {
      return JSON.parse(await this.execute(args)) as unknown;
    } catch (cause) {
      if (cause instanceof BeadsUnavailable) throw cause;
      throw new BeadsUnavailable({ cause });
    }
  }

  // The callers supply structured arguments. The lock survives the Loop
  // process exiting because bd inherits the descriptor via exec.
  private async execute(args: readonly string[], guard?: BeadsGuard) {
    let binary: string;
    try {
      await access(lock);
      binary = await beadsBinary(this.root);
    } catch (cause) {
      throw new BeadsNotStarted({ cause });
    }
    const check = guard
      ? "ready" in guard
        ? ["--ready", guard.ready]
        : ["--current", JSON.stringify(guard.current)]
      : [];
    try {
      const { stdout } = await exec(
        "python3",
        ["-I", lock, ...check, binary, "--sandbox", "--json", ...args],
        {
          cwd: this.directory,
          timeout: 45_000,
          killSignal: "SIGKILL",
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      return stdout;
    } catch (cause) {
      if (
        typeof cause === "object" &&
        cause !== null &&
        (("code" in cause && cause.code === "ENOENT") ||
          ("stderr" in cause && cause.stderr === "LOOP_BEADS_NOT_STARTED\n"))
      )
        throw new BeadsNotStarted({ cause });
      throw new BeadsUnavailable({ cause });
    }
  }
}
