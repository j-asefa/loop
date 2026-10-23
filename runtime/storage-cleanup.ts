type NpmEntry = {
  integrity: string;
  resolved?: string;
  link?: unknown;
  [key: string]: unknown;
};
type Contents = {
  files: Map<string, { size: number; hash: string }>;
  directories: Set<string>;
  bins: Map<string, Set<string>>;
};
type Receipt = {
  packages: Set<string>;
  entries: [string, NpmEntry][];
  head: string;
  top: string;
  contents?: Contents;
};
type Candidate =
  | { path: string; kind: "dependencies"; workspace: string }
  | { path: string; kind: "browser-cache" }
  | { path: string; kind: "npm-cache"; hash: string };
export type Outcome = {
  path?: string;
  kind: string;
  removed: boolean;
  reason?: string;
  bytes?: number;
  eligible?: boolean;
};
import {
  constants,
  openSync,
  closeSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readSync,
  readlinkSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { gunzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

let deadline = Infinity;
const checkBudget = () => {
  if (Date.now() >= deadline)
    throw new Error("Storage maintenance time budget exhausted");
};
const DAY = 24 * 60 * 60 * 1000;
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return (
    !!rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep)
  );
};
const stat = (path: string) => {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};
function regularJson(path: string): any {
  const s = stat(path);
  if (!s?.isFile() || s.size > 8 * 1024 * 1024)
    throw new Error("Missing or invalid install metadata");
  return JSON.parse(readFileSync(path, "utf8"));
}
function contained(root: string, path: string) {
  if (!inside(root, path) || realpathSync(path) !== path)
    throw new Error("Path leaves the managed home or traverses a symlink");
}
function git(repo: string, ...args: string[]) {
  checkBudget();
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    timeout: Math.max(1, Math.min(10000, deadline - Date.now())),
    maxBuffer: 8 * 1024 * 1024,
    // Maintenance must not run a repository-supplied fsmonitor command.
    env: {
      ...process.env,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_VALUE_0: "false",
      GIT_OPTIONAL_LOCKS: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

// File names alone are not deletion authority. An npm receipt must agree with
// the project's lockfile. Contents are checked separately against cached payloads.
// Unknown layouts (including Bun/pnpm and editable/file dependencies) are kept.
function npmReceipt(home: string, path: string): Receipt {
  const project = dirname(path);
  const receiptPath = join(path, ".package-lock.json");
  const receipt = regularJson(receiptPath);
  const lock = regularJson(join(project, "package-lock.json"));
  regularJson(join(project, "package.json"));
  if (
    ![2, 3].includes(receipt.lockfileVersion) ||
    !lock.packages ||
    !receipt.packages
  )
    throw new Error("Unsupported npm install receipt");
  const packages = new Set<string>();
  for (const [name, entry] of Object.entries<NpmEntry>(receipt.packages)) {
    const expected = lock.packages[name];
    if (
      !name.startsWith("node_modules/") ||
      name.split("/").some((p) => !p || p === "." || p === "..") ||
      !expected ||
      entry.link ||
      !/^https:\/\/registry\.npmjs\.org\//.test(entry.resolved || "") ||
      !/^sha(?:256|384|512)-[A-Za-z0-9+/]+=*$/.test(entry.integrity || "") ||
      ["version", "resolved", "integrity"].some(
        (key) => expected[key] !== entry[key],
      )
    )
      throw new Error(
        "Install contains unverified, local or changed dependencies",
      );
    packages.add(name.slice("node_modules/".length));
  }
  if (!packages.size) throw new Error("Empty npm install receipt");
  const top = realpathSync(git(project, "rev-parse", "--show-toplevel"));
  contained(home, top);
  const common = realpathSync(
    resolve(project, git(project, "rev-parse", "--git-common-dir")),
  );
  contained(home, common);
  const rel = relative(top, path);
  git(top, "check-ignore", "--quiet", "--", rel + "/");
  if (git(top, "ls-files", "--cached", "--", rel))
    throw new Error("Dependency files are tracked by Git");
  if (
    git(
      top,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--ignore-submodules=none",
    )
  )
    throw new Error("Checkout has local work");
  const worktrees = git(top, "worktree", "list", "--porcelain", "-z").split(
    "\0\0",
  );
  if (
    worktrees.some(
      (entry) =>
        entry.startsWith(`worktree ${top}\0`) &&
        entry.split("\0").some((field) => /^locked(?: |$)/.test(field)),
    )
  )
    throw new Error("Worktree is locked");
  return {
    packages,
    entries: Object.entries<NpmEntry>(receipt.packages).map(
      ([name, entry]): [string, NpmEntry] => [
        name.slice("node_modules/".length),
        entry,
      ],
    ),
    head: git(top, "rev-parse", "HEAD"),
    top,
  };
}

// npm may refresh its hidden receipt without replacing modified package files.
// Only integrity-verified registry payloads can establish the expected contents.
// Unsupported archives, missing downloads and generated/extra files are kept.
function hashFile(path: string, algorithm = "sha256"): string {
  checkBudget();
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOATIME || 0));
  try {
    const hash = createHash(algorithm),
      buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      checkBudget();
      const length = readSync(fd, buffer, 0, buffer.length, null);
      if (!length) return hash.digest("hex");
      hash.update(buffer.subarray(0, length));
    }
  } finally {
    closeSync(fd);
  }
}

function npmContents(home: string, receipt: Receipt): Contents {
  const files = new Map<string, { size: number; hash: string }>();
  const directories = new Set(["", ".bin"]);
  const bins = new Map<string, Set<string>>();
  let total = 0;
  function parents(path: string) {
    for (
      let at = path.lastIndexOf("/");
      at >= 0;
      at = path.lastIndexOf("/", at - 1)
    ) {
      directories.add(path.slice(0, at));
      if (at === 0) break;
    }
  }
  for (const [name, entry] of receipt.entries) {
    checkBudget();
    const [algorithm, encoded] = entry.integrity.split("-");
    const hex = Buffer.from(encoded, "base64").toString("hex");
    const cached = join(
      home,
      ".npm",
      "_cacache",
      "content-v2",
      algorithm,
      hex.slice(0, 2),
      hex.slice(2, 4),
      hex.slice(4),
    );
    const s = stat(cached);
    if (!s?.isFile() || s.size > 32 * 1024 * 1024)
      throw new Error("No bounded trusted package payload for " + name);
    contained(home, cached);
    const fd = openSync(
      cached,
      constants.O_RDONLY | (constants.O_NOATIME || 0),
    );
    let compressed;
    try {
      compressed = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
    if (createHash(algorithm).update(compressed).digest("base64") !== encoded)
      throw new Error("Package payload does not match lockfile integrity");
    const archive = gunzipSync(compressed, {
      maxOutputLength: 64 * 1024 * 1024,
    });
    total += archive.length;
    if (total > 512 * 1024 * 1024)
      throw new Error("Package payloads exceed the maintenance scan limit");
    let packageJson: any, longPath: string | undefined;
    let globalPax: Record<string, string> = {},
      localPax: Record<string, string> = {};
    for (let at = 0; at + 512 <= archive.length;) {
      checkBudget();
      const header = archive.subarray(at, at + 512);
      if (header.every((byte) => byte === 0)) break;
      const field = (start: number, end: number) =>
        header.subarray(start, end).toString("utf8").replace(/\0.*$/s, "");
      // GNU headers use this area for timestamps, not a POSIX path prefix.
      const prefix = field(257, 263) === "ustar" ? field(345, 500) : "";
      const headerPath = (prefix ? prefix + "/" : "") + field(0, 100);
      const sizeField = field(124, 136).trim();
      if (!/^[0-7]+$/.test(sizeField))
        throw new Error("Unsupported npm archive size");
      const headerSize = parseInt(sizeField, 8);
      const kind = field(156, 157);
      const metadata = ["g", "x", "L"].includes(kind);
      const pax = { ...globalPax, ...localPax };
      const size =
        metadata || pax.size === undefined ? headerSize : Number(pax.size);
      if (
        !Number.isSafeInteger(size) ||
        size < 0 ||
        at + 512 + size > archive.length
      )
        throw new Error("Unsupported npm archive size");
      const contents = archive.subarray(at + 512, at + 512 + size);
      at += 512 + Math.ceil(size / 512) * 512;
      if (metadata) {
        if (kind === "L")
          longPath = contents.toString("utf8").replace(/\0.*$/s, "");
        else {
          const fields: Record<string, string> = {};
          for (let offset = 0; offset < contents.length;) {
            const space = contents.indexOf(32, offset);
            const lengthText = contents
              .subarray(offset, space)
              .toString("ascii");
            const length = Number(lengthText);
            if (
              space < offset ||
              !/^[0-9]+$/.test(lengthText) ||
              !Number.isSafeInteger(length) ||
              length <= space - offset + 2 ||
              offset + length > contents.length ||
              contents[offset + length - 1] !== 10
            )
              throw new Error("Invalid npm archive metadata");
            const record = contents
              .subarray(space + 1, offset + length - 1)
              .toString("utf8");
            const equal = record.indexOf("=");
            if (equal < 1 || /sparse/i.test(record.slice(0, equal)))
              throw new Error("Unsupported npm archive metadata");
            fields[record.slice(0, equal)] = record.slice(equal + 1);
            offset += length;
          }
          if (kind === "g") globalPax = { ...globalPax, ...fields };
          else localPax = { ...localPax, ...fields };
        }
        continue;
      }
      if (!["", "0", "5"].includes(kind))
        throw new Error("Unsupported npm archive entry");
      const path = pax.path ?? longPath ?? headerPath;
      localPax = {};
      longPath = undefined;
      const parts = path.replace(/\/$/, "").split("/");
      if (
        parts.some((part) => !part || part === "." || part === "..") ||
        /[\\\x00-\x1f\x7f]/.test(path)
      )
        throw new Error("Unsupported npm archive path");
      // npm strips one archive component; registries also contain payloads
      // rooted at the package name instead of the conventional package/.
      const clean = parts.slice(1).join("/");
      // Top-level entries disappear under npm's strip:1 extraction.
      if (!clean) continue;
      const rel = name + "/" + clean;
      parents(rel);
      if (kind === "5") directories.add(rel);
      else {
        if (files.has(rel)) throw new Error("Duplicate npm archive entry");
        files.set(rel, {
          size,
          hash: createHash("sha256").update(contents).digest("hex"),
        });
        if (clean === "package.json")
          packageJson = JSON.parse(contents.toString("utf8"));
      }
      if (files.size + directories.size > 250000)
        throw new Error("Package manifest exceeds scan limit");
    }
    if (!packageJson) throw new Error("Package payload has no manifest");
    const mapping =
      typeof packageJson.bin === "string"
        ? { [packageJson.name?.split("/").at(-1)]: packageJson.bin }
        : packageJson.bin || {};
    const scope = name.lastIndexOf("node_modules/");
    const binRoot =
      scope < 0 ? ".bin" : name.slice(0, scope) + "node_modules/.bin";
    directories.add(binRoot);
    parents(binRoot);
    for (const [bin, target] of Object.entries(mapping)) {
      if (!/^[^./\\][^/\\]*$/.test(bin) || typeof target !== "string")
        throw new Error("Unsupported package executable");
      const destination = join(name, target);
      if (!files.has(destination))
        throw new Error("Unverified package executable");
      const link = binRoot + "/" + bin;
      const targets = bins.get(link) || new Set();
      targets.add(destination);
      bins.set(link, targets);
    }
  }
  return { files, directories, bins };
}

function inspectTree(
  path: string,
  receipt?: Receipt,
  browserInstalledAt?: number,
) {
  const root = lstatSync(path);
  let newest = 0,
    bytes = 0,
    entries = 0;
  const digest = createHash("sha256");
  const seen = new Set();
  function walk(file: string, rel: string): void {
    checkBudget();
    if (++entries > 250000)
      throw new Error("Dependency tree exceeds the maintenance scan limit");
    const s = lstatSync(file);
    if (s.dev !== root.dev)
      throw new Error("Nested mount in cleanup candidate");
    digest.update(
      JSON.stringify([rel, s.dev, s.ino, s.mode, s.size, s.mtimeMs, s.ctimeMs]),
    );
    // Directory access and reading receipts during an inspection must not make
    // old installations appear newly used. Regular module reads do count.
    newest = Math.max(
      newest,
      s.mtimeMs,
      s.ctimeMs,
      s.isFile() &&
        !rel.endsWith("package.json") &&
        rel !== ".package-lock.json"
        ? s.atimeMs
        : 0,
    );
    const inode = `${s.dev}:${s.ino}`;
    if (!seen.has(inode)) {
      bytes += s.blocks * 512;
      seen.add(inode);
    }
    if (rel) {
      const name = rel.split("/").at(-1)!;
      if (
        /^(?:\.git|\.ssh)$/.test(name) ||
        (!s.isDirectory() &&
          (/^(?:\.env(?:\..*)?|\.npmrc|auth\.json|credentials(?:\.json)?|id_rsa|id_ed25519)$/.test(
            name,
          ) ||
            /\.(?:pem|key|p12)$/.test(name)))
      )
        throw new Error(
          `Potential user credentials or repository inside dependency tree: ${rel}`,
        );
      if (receipt) {
        const manifest = receipt.contents!;
        if (rel !== ".package-lock.json") {
          if (s.isDirectory()) {
            if (!manifest.directories.has(rel))
              throw new Error(`Unverified dependency directory: ${rel}`);
          } else if (s.isSymbolicLink()) {
            const destination = relative(
              path,
              resolve(dirname(file), readlinkSync(file)),
            );
            if (!manifest.bins.get(rel)?.has(destination))
              throw new Error(`Unverified dependency link: ${rel}`);
          } else if (
            !s.isFile() ||
            !manifest.files.has(rel) ||
            s.size !== manifest.files.get(rel)!.size ||
            hashFile(file) !== manifest.files.get(rel)!.hash
          ) {
            throw new Error(`Dependency differs from package payload: ${rel}`);
          }
        }
      }
      if (
        browserInstalledAt &&
        !s.isDirectory() &&
        name !== "DEPENDENCIES_VALIDATED" &&
        Math.max(s.mtimeMs, s.ctimeMs) > browserInstalledAt
      )
        throw new Error("Browser cache changed after installation");
    }
    if (s.isSymbolicLink()) {
      const target = resolve(dirname(file), readlinkSync(file));
      if (!inside(path, target))
        throw new Error("Dependency link points outside the installation");
    } else if (s.isDirectory()) {
      for (const name of readdirSync(file).sort())
        walk(join(file, name), rel ? rel + "/" + name : name);
    } else if (!s.isFile())
      throw new Error("Special file in cleanup candidate");
  }
  walk(path, "");
  return { newest, bytes, fingerprint: digest.digest("hex") };
}

function discover(
  home: string,
  workspaceKeys: string[],
  report: (path: string, error: unknown) => void,
  cursors: Record<string, string>,
  scanCache: boolean,
): Candidate[] {
  const candidates: Candidate[] = [];
  const visited = new Map<string, number>();
  // Leave most of the pass for verifying the candidates already found.
  const workspaceDeadline =
    Date.now() + Math.max(1, Math.min(2000, (deadline - Date.now()) / 3));
  const queues = new Map<
    string,
    { items: [string, string, number][]; at: number }
  >(
    workspaceKeys.map((key) => {
      const workspace = join(home, "workspaces", key);
      return [workspace, { items: [[workspace, workspace, 0]], at: 0 }];
    }),
  );
  function walk(path: string, workspace: string, depth = 0): void {
    checkBudget();
    const count = (visited.get(workspace) || 0) + 1;
    visited.set(workspace, count);
    if (count > 20000 || depth > 12) return;
    const s = stat(path);
    if (!s?.isDirectory() || realpathSync(path) !== path) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        [
          ".git",
          ".loop",
          ".loop-cleanup",
          ".cache",
          ".bun",
          ".npm",
          "dist",
          "build",
        ].includes(entry.name)
      )
        continue;
      const child = join(path, entry.name);
      if (entry.name === "node_modules")
        candidates.push({ path: child, kind: "dependencies", workspace });
      else if (queues.get(workspace)!.items.length < 20000)
        queues.get(workspace)!.items.push([child, workspace, depth + 1]);
    }
  }
  // Round-robin breadth-first discovery gives every workspace a turn at each
  // depth, even when another has thousands of children at that depth.
  discovery: for (;;) {
    let advanced = false;
    for (const queue of queues.values()) {
      if (Date.now() >= workspaceDeadline) break discovery;
      if (queue.at >= queue.items.length) continue;
      advanced = true;
      const [path, workspace, depth] = queue.items[queue.at++];
      try {
        walk(path, workspace, depth);
      } catch (error) {
        report(path, error);
        if (Date.now() >= deadline) return candidates;
      }
    }
    if (!advanced) break;
  }
  const cacheDeadline =
    Date.now() + Math.max(1, Math.min(1000, (deadline - Date.now()) / 3));
  const entries = (path: string, index = false): string[] => {
    try {
      checkBudget();
      if (!index && Date.now() >= cacheDeadline) return [];
      return stat(path)?.isDirectory() && realpathSync(path) === path
        ? readdirSync(path)
        : [];
    } catch (error) {
      report(path, error);
      return [];
    }
  };
  const browsers = join(home, ".cache", "ms-playwright");
  {
    for (const name of entries(browsers)) {
      if (
        /^(?:chromium|chromium_headless_shell|firefox|webkit|ffmpeg)-\d+$/.test(
          name,
        )
      )
        candidates.push({ path: join(browsers, name), kind: "browser-cache" });
    }
  }
  // npm's content-addressed download blobs only. Never sweep an entire .cache,
  // .npm or provider home: those may also hold credentials or native history.
  if (!scanCache) return candidates;
  const content = join(home, ".npm", "_cacache", "content-v2", "sha512");
  {
    // Enumerate only the two directory levels (at most 257 reads), then rotate
    // the expensive blob enumeration independently of candidate processing.
    const prefixes = [];
    for (const a of entries(content, true)) {
      if (!/^[a-f0-9]{2}$/.test(a)) continue;
      for (const b of entries(join(content, a), true))
        if (/^[a-f0-9]{2}$/.test(b)) prefixes.push(a + "/" + b);
    }
    const cursor = cursors["npm-discovery"] || "";
    prefixes.sort(
      (a, b) =>
        Number(a <= cursor) - Number(b <= cursor) ||
        (a < b ? -1 : a > b ? 1 : 0),
    );
    for (const prefix of prefixes) {
      if (Date.now() >= cacheDeadline) break;
      const [a, b] = prefix.split("/");
      for (const name of entries(join(content, a, b)))
        if (/^[a-f0-9]{124}$/.test(name))
          candidates.push({
            path: join(content, a, b, name),
            kind: "npm-cache",
            hash: a + b + name,
          });
      cursors["npm-discovery"] = prefix;
    }
  }
  return candidates;
}

// Protect verification inputs for every remaining installation, including
// workspaces outside this pass. Incomplete discovery never authorizes deletion.
function neededPayloads(home: string): Set<string> {
  const hashes = new Set<string>();
  const until = Math.min(deadline, Date.now() + 2000);
  let count = 0;
  function walk(path: string, depth = 0): void {
    if (Date.now() >= until || ++count > 20000 || depth > 14)
      throw new Error("Incomplete dependency reference scan");
    const s = stat(path);
    if (!s) return;
    if (!s.isDirectory() || realpathSync(path) !== path)
      throw new Error("Unverified workspace in reference scan");
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (
        [".git", ".loop", ".loop-cleanup", ".cache", ".npm", ".bun"].includes(
          entry.name,
        )
      )
        continue;
      const child = join(path, entry.name);
      // Discovery never follows links; their targets cannot become deletion
      // candidates through this path. Canonical directories are scanned below.
      if (entry.isSymbolicLink()) continue;
      if (!entry.isDirectory()) continue;
      if (entry.name !== "node_modules") {
        walk(child, depth + 1);
        continue;
      }
      // Only npm installations with a receipt can use cache blobs as deletion
      // authority. Bun/pnpm and incomplete installs are preserved themselves
      // and must not disable unrelated download-cache reclamation.
      let receipt;
      try {
        receipt = regularJson(join(child, ".package-lock.json"));
      } catch {
        continue;
      }
      if (!receipt.packages) continue;
      for (const item of Object.values<NpmEntry>(receipt.packages)) {
        if (typeof item.integrity !== "string") continue;
        const match = /^sha512-([A-Za-z0-9+/]+=*)$/.exec(item.integrity);
        if (match) hashes.add(Buffer.from(match[1], "base64").toString("hex"));
      }
    }
  }
  walk(join(home, "workspaces"));
  return hashes;
}

// Call only under the broker's per-connection maintenance lock, after all its
// runtime containers have stopped. This never runs in native/companion homes.
export function cleanupStorage({
  home,
  workspaceKeys,
  dryRun = false,
  recordProgress = false,
  timeBudgetMs = 10_000,
  now = Date.now(),
  dependencyAgeMs = DAY,
  cacheAgeMs = 7 * DAY,
  maxDependencies = 4,
  maxCacheFiles = 256,
  maxBrowsers = 1,
}: {
  home: string;
  workspaceKeys: string[];
  dryRun?: boolean;
  recordProgress?: boolean;
  timeBudgetMs?: number;
  now?: number;
  dependencyAgeMs?: number;
  cacheAgeMs?: number;
  maxDependencies?: number;
  maxCacheFiles?: number;
  maxBrowsers?: number;
}): Outcome[] {
  deadline = Date.now() + Math.min(30_000, Math.max(1, timeBudgetMs));
  home = realpathSync(home);
  if (
    !Array.isArray(workspaceKeys) ||
    workspaceKeys.length > 100 ||
    workspaceKeys.some((key) => !/^[a-f0-9]{64}$/.test(key))
  )
    throw new Error("Invalid cleanup workspaces");
  const stateDir = join(home, ".loop-storage");
  if (
    stat(stateDir) &&
    (!stat(stateDir)!.isDirectory() || realpathSync(stateDir) !== stateDir)
  )
    throw new Error("Invalid storage maintenance directory");
  let state: Record<string, any> = {};
  try {
    state = regularJson(join(stateDir, "checked.json"));
  } catch {}
  // Three path cursors replace an unbounded per-file timestamp dictionary.
  // Keep at most one cursor per batch of workspace keys plus global caches.
  const batch = createHash("sha256")
    .update([...workspaceKeys].sort().join(":"))
    .digest("hex");
  if (state?.version !== 2) state = { version: 2, batches: {}, caches: {} };
  if (
    !state.batches ||
    typeof state.batches !== "object" ||
    Array.isArray(state.batches)
  )
    state.batches = {};
  if (
    !state.caches ||
    typeof state.caches !== "object" ||
    Array.isArray(state.caches)
  )
    state.caches = {};
  const previous = state.batches[batch];
  const cursors: Record<string, string> = {
    ...state.caches,
    dependencies: typeof previous?.cursor === "string" ? previous.cursor : "",
  };
  const results: Outcome[] = [];
  const candidates = discover(
    home,
    workspaceKeys,
    (path, error) => {
      if (results.length < 100)
        results.push({
          path: relative(home, path),
          kind: "discovery",
          removed: false,
          reason: (error as Error).message,
        });
    },
    cursors,
    maxCacheFiles > 0,
  ).sort((a, b) => {
    const kind =
      Number(a.kind === "npm-cache") - Number(b.kind === "npm-cache") ||
      a.kind.localeCompare(b.kind);
    if (kind) return kind;
    const cursor = typeof cursors[a.kind] === "string" ? cursors[a.kind] : "";
    const left = relative(home, a.path),
      right = relative(home, b.path);
    return (
      Number(left <= cursor) - Number(right <= cursor) ||
      (left < right ? -1 : left > right ? 1 : 0)
    );
  });
  let dependencies = 0,
    caches = 0,
    browsers = 0;
  let needed: Set<string> | undefined, referenceError: unknown;
  for (const candidate of candidates) {
    if (Date.now() >= deadline) {
      results.push({
        kind: "budget",
        removed: false,
        reason: "Storage maintenance time budget exhausted",
      });
      break;
    }
    if (
      candidate.kind === "dependencies"
        ? dependencies >= maxDependencies
        : candidate.kind === "browser-cache"
          ? browsers >= maxBrowsers
          : caches >= maxCacheFiles
    )
      continue;
    const rel = relative(home, candidate.path);
    const outcome: Outcome = {
      path: rel,
      kind: candidate.kind,
      removed: false,
    };
    try {
      contained(home, candidate.path);
      const s = lstatSync(candidate.path);
      if (candidate.kind === "dependencies") {
        dependencies++;
        const used = stat(join(candidate.workspace, ".loop-last-used"));
        if (used && !used.isFile())
          throw new Error("Invalid workspace activity marker");
        if (used && used.mtimeMs > now - dependencyAgeMs)
          throw new Error("Recently used dependencies");
        if (inspectTree(candidate.path).newest > now - dependencyAgeMs)
          throw new Error("Recently used dependencies");
        const receipt = npmReceipt(candidate.workspace, candidate.path);
        receipt.contents = npmContents(home, receipt);
        const info = inspectTree(candidate.path, receipt);
        outcome.bytes = info.bytes;
        if (!dryRun) {
          const verified = npmReceipt(candidate.workspace, candidate.path);
          if (
            verified.head !== receipt.head ||
            JSON.stringify(verified.entries) !==
              JSON.stringify(receipt.entries) ||
            inspectTree(candidate.path).fingerprint !== info.fingerprint
          )
            throw new Error("Installation changed during inspection");
          // The broker excludes writers. Recheck the canonical root immediately
          // before removal; rm unlinks package symlinks without following them.
          contained(home, candidate.path);
          rmSync(candidate.path, { recursive: true });
        }
      } else if (candidate.kind === "browser-cache") {
        browsers++;
        const marker = stat(join(candidate.path, "INSTALLATION_COMPLETE"));
        if (!s.isDirectory() || !marker?.isFile())
          throw new Error("Unverified browser installation");
        const info = inspectTree(
          candidate.path,
          undefined,
          Math.max(marker.mtimeMs, marker.ctimeMs),
        );
        if (info.newest > now - cacheAgeMs)
          throw new Error("Recently used browser cache");
        outcome.bytes = info.bytes;
        if (!dryRun) {
          if (
            inspectTree(
              candidate.path,
              undefined,
              Math.max(marker.mtimeMs, marker.ctimeMs),
            ).fingerprint !== info.fingerprint
          )
            throw new Error("Browser cache changed during inspection");
          contained(home, candidate.path);
          rmSync(candidate.path, { recursive: true });
        }
      } else {
        caches++;
        if (!needed && !referenceError) {
          try {
            needed = neededPayloads(home);
          } catch (error) {
            referenceError = error;
          }
        }
        if (referenceError) throw referenceError;
        if (needed!.has(candidate.hash))
          throw new Error("Payload is needed by retained dependencies");
        if (!s.isFile()) throw new Error("Cache entry is not a regular file");
        if (Math.max(s.atimeMs, s.mtimeMs, s.ctimeMs) > now - cacheAgeMs)
          throw new Error("Recently used cache entry");
        if (s.size > 512 * 1024 * 1024)
          throw new Error("Cache entry exceeds the maintenance scan limit");
        if (hashFile(candidate.path, "sha512") !== candidate.hash)
          throw new Error("Cache entry does not match its content address");
        outcome.bytes = s.nlink === 1 ? s.blocks * 512 : 0;
        if (!dryRun) {
          const current = lstatSync(candidate.path);
          if (
            current.ino !== s.ino ||
            current.dev !== s.dev ||
            current.mtimeMs !== s.mtimeMs ||
            current.ctimeMs !== s.ctimeMs ||
            current.size !== s.size
          )
            throw new Error("Cache entry changed during inspection");
          contained(home, candidate.path);
          rmSync(candidate.path);
        }
      }
      outcome.removed = !dryRun;
      outcome.eligible = true;
    } catch (error) {
      outcome.reason =
        Date.now() >= deadline
          ? "Storage maintenance time budget exhausted"
          : (error as { cmd?: string }).cmd ||
              (error as { status?: unknown }).status !== undefined
            ? "Could not verify the checkout"
            : (error as Error).message;
    }
    cursors[candidate.kind] = rel;
    results.push(outcome);
  }
  if (
    !dryRun ||
    (recordProgress && !results.some((result) => result.eligible))
  ) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    state = {
      version: 2,
      batches: Object.fromEntries(
        Object.entries<{ cursor: string; checkedAt: number }>({
          ...state.batches,
          [batch]: { cursor: cursors.dependencies || "", checkedAt: now },
        })
          .filter(
            ([key, value]) =>
              /^[a-f0-9]{64}$/.test(key) &&
              typeof value?.cursor === "string" &&
              value.cursor.length <= 4096,
          )
          .sort((a, b) => Number(b[1].checkedAt) - Number(a[1].checkedAt))
          .slice(0, 100),
      ),
      caches: Object.fromEntries(
        ["browser-cache", "npm-cache", "npm-discovery"].map((kind) => [
          kind,
          typeof cursors[kind] === "string" ? cursors[kind].slice(0, 4096) : "",
        ]),
      ),
    };
    const temp = join(stateDir, randomUUID() + ".tmp");
    writeFileSync(temp, JSON.stringify(state), { mode: 0o600, flag: "wx" });
    renameSync(temp, join(stateDir, "checked.json"));
    const last = join(stateDir, randomUUID() + ".tmp");
    writeFileSync(last, JSON.stringify({ checkedAt: now, results }), {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(last, join(stateDir, "last-result.json"));
  }
  return results;
}
