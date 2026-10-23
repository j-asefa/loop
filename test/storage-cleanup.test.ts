import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
  utimesSync,
  statSync,
  chmodSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
const { cleanupStorage } = await import(resolve("runtime/storage-cleanup.ts"));
const { managedWorkspace } = await import(resolve("runtime/workspace.ts"));
const DAY = 86400000;
const key = "a".repeat(64);
let home: string, workspace: string, repo: string, modules: string, now: number;
const git = (...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" })
    .toString()
    .trim();
const put = (path: string, text: string) => {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
const run = (extra = {}) =>
  cleanupStorage({
    home,
    workspaceKeys: [key],
    now,
    maxCacheFiles: 0,
    ...extra,
  });
function install(path: string, value = 42, format = "ustar", root = "package") {
  put(join(path, "pkg", "index.js"), `module.exports = ${value};`);
  put(
    join(path, "pkg", "package.json"),
    JSON.stringify({ name: "pkg", version: "1.0.0" }),
  );
  // Package extraction precedes writing npm's hidden install receipt.
  for (const name of ["index.js", "package.json"])
    utimesSync(join(path, "pkg", name), new Date(1000), new Date(1000));
  // Cache the actual registry payload under its verified content address.
  // npm packages use a package/ root. Make that archive without changing the
  // installed tree or trusting an installation-generated receipt.
  const staging = mkdtempSync(join(home, "payload-"));
  mkdirSync(join(staging, root));
  for (const name of ["index.js", "package.json"])
    writeFileSync(
      join(staging, root, name),
      readFileSync(join(path, "pkg", name)),
    );
  for (const name of [root, root + "/index.js", root + "/package.json"])
    utimesSync(join(staging, name), new Date(1000), new Date(1000));
  let archive = execFileSync("tar", [
    "--format=" + (format === "gnu" ? "ustar" : format),
    "-cf",
    "-",
    "-C",
    staging,
    root,
  ]);
  if (format === "gnu") {
    // Deterministic GNU headers: macOS tar cannot create GNU format. GNU's
    // timestamp fields overlap the POSIX prefix and must not enter the path.
    for (let at = 0; at + 512 <= archive.length && archive[at];) {
      const header = archive.subarray(at, at + 512);
      const size = parseInt(header.subarray(124, 136).toString(), 8) || 0;
      header.write("ustar  \0", 257);
      header.write("00000000001\0", 345);
      header.fill(32, 148, 156);
      const sum = [...header].reduce((a, b) => a + b, 0);
      header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
      at += 512 + Math.ceil(size / 512) * 512;
    }
    const contents = Buffer.from(root + "/index.js\0");
    const header = Buffer.from(archive.subarray(0, 512));
    header.fill(0, 0, 100);
    header.write("././@LongLink");
    header.fill(0, 124, 136);
    header.write(contents.length.toString(8).padStart(11, "0"), 124);
    header.write("L", 156);
    header.fill(32, 148, 156);
    const sum = [...header].reduce((a, b) => a + b, 0);
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    const body = Buffer.alloc(Math.ceil(contents.length / 512) * 512);
    contents.copy(body);
    // Insert before index.js, independently of filesystem entry order.
    let offset = 0;
    while (
      !archive
        .subarray(offset, offset + 100)
        .toString()
        .startsWith(root + "/index.js\0")
    ) {
      const size =
        parseInt(archive.subarray(offset + 124, offset + 136).toString(), 8) ||
        0;
      offset += 512 + Math.ceil(size / 512) * 512;
      if (offset >= archive.length) throw new Error("Missing fixture entry");
    }
    archive = Buffer.concat([
      archive.subarray(0, offset),
      header,
      body,
      archive.subarray(offset),
    ]);
  }
  const payload = gzipSync(archive);
  rmSync(staging, { recursive: true });
  const digest = createHash("sha512").update(payload).digest();
  const hex = digest.toString("hex");
  const cache = join(
    home,
    ".npm/_cacache/content-v2/sha512",
    hex.slice(0, 2),
    hex.slice(2, 4),
    hex.slice(4),
  );
  mkdirSync(resolve(cache, ".."), { recursive: true });
  writeFileSync(cache, payload);
  const packages = {
    "node_modules/pkg": {
      version: "1.0.0",
      resolved: "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz",
      integrity: "sha512-" + digest.toString("base64"),
    },
  };
  put(
    join(path, ".package-lock.json"),
    JSON.stringify({ lockfileVersion: 3, packages }),
  );
  return packages;
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "loop-storage-"));
  // macOS /var is a symlink; use the canonical managed root, as Docker does.
  home = execFileSync(process.execPath, [
    "-e",
    "console.log(require('fs').realpathSync(process.argv[1]))",
    home,
  ])
    .toString()
    .trim();
  workspace = managedWorkspace(home, key);
  repo = join(workspace, "repo");
  modules = join(repo, "node_modules");
  mkdirSync(repo);
  git("init", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  const packages = install(modules);
  put(join(repo, ".gitignore"), "node_modules/\n.env\n");
  put(
    join(repo, "package.json"),
    JSON.stringify({ name: "fixture", dependencies: { pkg: "1.0.0" } }),
  );
  put(
    join(repo, "package-lock.json"),
    JSON.stringify({ lockfileVersion: 3, packages }),
  );
  put(join(repo, "source.ts"), "valuable source");
  git("add", ".");
  git("commit", "-m", "fixture");
  now = Date.now() + 10 * DAY;
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

it("previews and then removes a populated stale npm installation without a PR or GitHub credential", () => {
  const preview = run({ dryRun: true });
  expect(preview).toHaveLength(1);
  expect(preview[0]).toMatchObject({
    kind: "dependencies",
    eligible: true,
    removed: false,
  });
  expect(existsSync(modules)).toBe(true);
  expect(existsSync(join(home, ".loop-storage"))).toBe(false);
  expect(run()[0]).toMatchObject({ eligible: true, removed: true });
  expect(existsSync(modules)).toBe(false);
  expect(readFileSync(join(repo, "source.ts"), "utf8")).toBe("valuable source");
  expect(git("branch", "--show-current")).toBe("main");
  expect(run()).toEqual([]);
});

it("runs storage inspection through the shipped cleanup entrypoint without GitHub", () => {
  const text = execFileSync(process.execPath, [resolve("runtime/entry.ts")], {
    input:
      JSON.stringify({
        provider: "file",
        action: "cleanup",
        workspaceKeys: [key],
      }) + "\n",
    env: { ...process.env, HOME: home, LOOP_RUNTIME_MODE: "docker" },
    encoding: "utf8",
  });
  const response = JSON.parse(text.trim());
  expect(response.result.results).toEqual([]);
  expect(
    response.result.storage.find((r: any) => r.kind === "dependencies"),
  ).toMatchObject({
    kind: "dependencies",
    removed: false,
    reason: "Recently used dependencies",
  });
});

it.each([
  "local-file",
  "modified-package",
  "credential",
  "unrecognized",
  "missing-receipt",
  "missing-payload",
  "tampered-payload",
  "generated-files",
  "local-dependency",
  "tracked",
  "dirty",
  "locked",
  "symlink",
])("preserves %s", (kind) => {
  if (kind === "local-file" || kind === "modified-package") {
    const file = join(
      modules,
      "pkg",
      kind === "local-file" ? "local-notes.txt" : "index.js",
    );
    put(file, "keep local work");
    utimesSync(file, new Date(now - 2 * DAY), new Date(now - 2 * DAY));
  }
  if (kind === "missing-payload")
    rmSync(join(home, ".npm"), { recursive: true });
  if (kind === "tampered-payload") {
    const receipt = JSON.parse(
      readFileSync(join(modules, ".package-lock.json"), "utf8"),
    );
    const hex = Buffer.from(
      receipt.packages["node_modules/pkg"].integrity.split("-")[1],
      "base64",
    ).toString("hex");
    writeFileSync(
      join(
        home,
        ".npm/_cacache/content-v2/sha512",
        hex.slice(0, 2),
        hex.slice(2, 4),
        hex.slice(4),
      ),
      "untrusted replacement",
    );
  }
  if (kind === "generated-files")
    put(join(modules, ".vite", "notes.json"), "keep");
  if (kind === "credential") put(join(modules, "pkg", ".env"), "keep secret");
  if (kind === "unrecognized") put(join(modules, "my-notes.txt"), "keep");
  if (kind === "missing-receipt") rmSync(join(modules, ".package-lock.json"));
  if (kind === "local-dependency") {
    const p = join(modules, ".package-lock.json");
    const receipt = JSON.parse(readFileSync(p, "utf8"));
    receipt.packages["node_modules/pkg"].resolved = "file:../source";
    writeFileSync(p, JSON.stringify(receipt));
  }
  if (kind === "tracked") {
    git("add", "-f", "node_modules/pkg/index.js");
    git("commit", "-m", "track dependency");
  }
  if (kind === "dirty") put(join(repo, "source.ts"), "unfinished source");
  if (kind === "locked") {
    const job = join(workspace, "job");
    git("worktree", "add", "-b", "job", job);
    git("worktree", "lock", job);
    rmSync(modules, { recursive: true });
    modules = join(job, "node_modules");
    install(modules);
  }
  if (kind === "symlink") {
    rmSync(modules, { recursive: true });
    const external = join(home, "valuable");
    put(join(external, "keep.txt"), "keep");
    symlinkSync(external, modules);
  }
  const result = run();
  expect(result.some((r: any) => r.removed)).toBe(false);
  expect(existsSync(modules)).toBe(true);
});

it("keeps recent module reads and recent agent turns, even with an old installation", () => {
  const file = join(modules, "pkg", "index.js");
  utimesSync(file, new Date(now), statSync(file).mtime);
  expect(run()[0].reason).toBe("Recently used dependencies");
  utimesSync(file, new Date(1000), new Date(1000));
  managedWorkspace(home, key, true);
  utimesSync(join(workspace, ".loop-last-used"), new Date(now), new Date(now));
  expect(run()[0].reason).toBe("Recently used dependencies");
});

it("does not let a blocked candidate starve later installations", () => {
  const other = join(workspace, "z-repo");
  execFileSync("git", ["clone", repo, other], { stdio: "pipe" });
  install(join(other, "node_modules"));
  put(join(modules, "keep.txt"), "local notes");
  expect(run({ maxDependencies: 1 })[0].removed).toBe(false);
  // A separate server batch must not erase this batch's inspection cursor.
  cleanupStorage({
    home,
    workspaceKeys: ["b".repeat(64)],
    now,
    maxCacheFiles: 0,
  });
  expect(run({ maxDependencies: 1 })[0]).toMatchObject({ removed: true });
  expect(existsSync(modules)).toBe(true);
  expect(existsSync(join(other, "node_modules"))).toBe(false);
});

it("prunes only stale verified npm content blobs, preserving credentials and unknown caches", () => {
  rmSync(join(home, ".npm"), { recursive: true });
  const bytes = Buffer.from("downloaded package");
  const hash = createHash("sha512").update(bytes).digest("hex");
  const file = join(
    home,
    ".npm",
    "_cacache",
    "content-v2",
    "sha512",
    hash.slice(0, 2),
    hash.slice(2, 4),
    hash.slice(4),
  );
  put(file, bytes.toString());
  put(join(home, ".npmrc"), "token");
  put(join(home, ".cache", "unknown", "keep.txt"), "keep");
  const result = run({ maxDependencies: 0, maxCacheFiles: 256 });
  expect(result).toMatchObject([
    { kind: "npm-cache", removed: true, eligible: true },
  ]);
  expect(existsSync(file)).toBe(false);
  expect(readFileSync(join(home, ".npmrc"), "utf8")).toBe("token");
  expect(existsSync(join(home, ".cache", "unknown", "keep.txt"))).toBe(true);
  put(file, "unexpected local data");
  expect(run({ maxDependencies: 0, maxCacheFiles: 256 })[0].reason).toBe(
    "Cache entry does not match its content address",
  );
  expect(existsSync(file)).toBe(true);
  put(file, bytes.toString());
  utimesSync(file, new Date(now), new Date(now));
  expect(run({ maxDependencies: 0, maxCacheFiles: 256 })[0].reason).toBe(
    "Recently used cache entry",
  );
});

it("restricts discovery to supplied agent identities and rejects symlinked maintenance state", () => {
  expect(
    cleanupStorage({
      home,
      workspaceKeys: ["b".repeat(64)],
      now,
      maxCacheFiles: 0,
    }),
  ).toEqual([]);
  expect(existsSync(modules)).toBe(true);
  expect(() => cleanupStorage({ home, workspaceKeys: ["../escape"] })).toThrow(
    "Invalid cleanup",
  );
  rmSync(join(home, ".loop-storage"), { recursive: true });
  symlinkSync(repo, join(home, ".loop-storage"));
  expect(() => run()).toThrow("Invalid storage maintenance");
});

it("cleans old completed Playwright browsers and preserves modified or unverified caches", () => {
  const browser = join(home, ".cache", "ms-playwright", "chromium-1234");
  put(join(browser, "chrome-linux", "chrome"), "downloaded executable");
  utimesSync(
    join(browser, "chrome-linux", "chrome"),
    new Date(1000),
    new Date(1000),
  );
  put(join(browser, "INSTALLATION_COMPLETE"), "");
  const unknown = join(
    home,
    ".cache",
    "ms-playwright",
    "my-browser",
    "keep.txt",
  );
  put(unknown, "keep");
  expect(run({ maxDependencies: 0, maxCacheFiles: 0 })[0]).toMatchObject({
    kind: "browser-cache",
    removed: true,
  });
  expect(existsSync(browser)).toBe(false);
  expect(existsSync(unknown)).toBe(true);
  put(join(browser, "chrome-linux", "chrome"), "downloaded executable");
  expect(run({ maxDependencies: 0, maxCacheFiles: 0 })[0].reason).toBe(
    "Unverified browser installation",
  );
  put(join(browser, "INSTALLATION_COMPLETE"), "");
  put(join(browser, "my-notes.txt"), "keep local work");
  utimesSync(
    join(browser, "my-notes.txt"),
    new Date(now - 2 * DAY),
    new Date(now - 2 * DAY),
  );
  expect(run({ maxDependencies: 0, maxCacheFiles: 0 })[0].reason).toBe(
    "Browser cache changed after installation",
  );
  expect(existsSync(join(browser, "my-notes.txt"))).toBe(true);
});

it.each(["index.js", "local-notes.txt"])(
  "preserves %s after an offline npm install refreshes its receipt",
  (name) => {
    const local = join(modules, "pkg", name);
    put(local, "valuable local change");
    utimesSync(local, new Date(1000), new Date(1000));
    execFileSync(
      "npm",
      [
        "install",
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--cache",
        join(home, ".npm"),
      ],
      {
        cwd: repo,
        stdio: "pipe",
        timeout: 30000,
      },
    );
    git("add", "package.json", "package-lock.json");
    git("commit", "--allow-empty", "-m", "Refresh npm metadata");
    expect(
      statSync(join(modules, ".package-lock.json")).mtimeMs,
    ).toBeGreaterThan(statSync(local).mtimeMs);
    expect(readFileSync(local, "utf8")).toBe("valuable local change");
    expect(run()[0]).toMatchObject({
      removed: false,
      reason: expect.stringContaining("differs from package payload"),
    });
    expect(readFileSync(local, "utf8")).toBe("valuable local change");
  },
  30000,
);

it.skipIf(process.platform !== "linux")(
  "does not refresh package access times during content verification",
  () => {
    const file = join(modules, "pkg", "index.js");
    utimesSync(file, new Date(1000), new Date(1000));
    const integrity = JSON.parse(
      readFileSync(join(modules, ".package-lock.json"), "utf8"),
    ).packages["node_modules/pkg"].integrity;
    const hash = Buffer.from(integrity.split("-")[1], "base64").toString("hex");
    const cached = join(
      home,
      ".npm/_cacache/content-v2/sha512",
      hash.slice(0, 2),
      hash.slice(2, 4),
      hash.slice(4),
    );
    utimesSync(cached, new Date(1000), new Date(1000));
    const cachedAccess = statSync(cached).atimeMs;
    const access = statSync(file).atimeMs;
    expect(run({ dryRun: true })[0]).toMatchObject({
      eligible: true,
      removed: false,
    });
    expect(statSync(file).atimeMs).toBe(access);
    expect(statSync(cached).atimeMs).toBe(cachedAccess);
  },
);

it("continues past unreadable discovery directories", () => {
  const blocked = join(workspace, "000-blocked");
  mkdirSync(blocked);
  chmodSync(blocked, 0);
  try {
    const results = run();
    expect(
      results.some((row: any) => row.kind === "dependencies" && row.removed),
    ).toBe(true);
    if (process.getuid?.() !== 0)
      expect(
        results.some(
          (row: any) => row.kind === "discovery" && /EACCES/.test(row.reason),
        ),
      ).toBe(true);
  } finally {
    chmodSync(blocked, 0o700);
  }
});

it("does not let an invalid activity marker break turns or leak temporary files", () => {
  mkdirSync(join(workspace, ".loop-last-used"));
  expect(() => managedWorkspace(home, key, true)).not.toThrow();
  expect(
    readdirSync(workspace).filter((name) =>
      name.startsWith(".loop-last-used-"),
    ),
  ).toEqual([]);
  expect(run()[0].reason).toBe("Invalid workspace activity marker");
  expect(existsSync(modules)).toBe(true);
});

it("preserves backdated browser edits after the retention window", async () => {
  const browser = join(home, ".cache/ms-playwright/chromium-1234");
  const file = join(browser, "chrome-linux/chrome");
  put(file, "original");
  put(join(browser, "INSTALLATION_COMPLETE"), "");
  await new Promise((resolve) => setTimeout(resolve, 20));
  put(file, "local change");
  utimesSync(file, new Date(1000), new Date(1000));
  expect(run({ maxDependencies: 0 })[0].reason).toBe(
    "Browser cache changed after installation",
  );
  expect(readFileSync(file, "utf8")).toBe("local change");
});

it("bounds maintenance work and replaces legacy unbounded cursor state", () => {
  put(
    join(home, ".loop-storage/checked.json"),
    JSON.stringify(
      Object.fromEntries(
        Array.from({ length: 30000 }, (_, i) => ["workspaces/old-" + i, i]),
      ),
    ),
  );
  const results = run({ timeBudgetMs: 1 });
  expect(results.some((row: any) => /budget/.test(row.reason || ""))).toBe(
    true,
  );
  expect(existsSync(modules)).toBe(true);
  expect(statSync(join(home, ".loop-storage/checked.json")).size).toBeLessThan(
    10000,
  );
});

it("discovers later workspace roots despite a large earlier tree", () => {
  const otherKey = "b".repeat(64);
  const other = managedWorkspace(home, otherKey);
  const target = join(other, "repo");
  execFileSync("git", ["clone", repo, target], { stdio: "pipe" });
  install(join(target, "node_modules"));
  for (let i = 0; i < 20010; i++) mkdirSync(join(workspace, "dir-" + i));
  const results = run({ workspaceKeys: [key, otherKey], timeBudgetMs: 30000 });
  expect(
    results.some((row: any) => row.path.includes(otherKey) && row.removed),
  ).toBe(true);
});

it("runs registered checkout inspection even when storage metadata is invalid", () => {
  put(join(home, ".loop-storage"), "invalid metadata");
  const registry = join(workspace, ".loop-cleanup");
  put(
    join(registry, "f".repeat(64) + ".json"),
    JSON.stringify({
      checkout: "repo",
      pr: "https://github.com/acme/project/pull/42",
    }),
  );
  const bin = join(home, "bin");
  put(join(bin, "gh"), "#!/bin/sh\nprintf '%s' '{\"merged\":false}'\n");
  chmodSync(join(bin, "gh"), 0o755);
  const text = execFileSync(process.execPath, [resolve("runtime/entry.ts")], {
    input:
      JSON.stringify({
        provider: "file",
        action: "cleanup",
        workspaceKeys: [key],
        githubToken: "fixture",
      }) + "\n",
    env: {
      ...process.env,
      HOME: home,
      PATH: bin + ":" + process.env.PATH,
      LOOP_RUNTIME_MODE: "docker",
    },
    encoding: "utf8",
  });
  const response = JSON.parse(text.trim()).result;
  expect(response.storage[0].reason).toMatch(/Invalid storage/);
  expect(response.results).toHaveLength(1);
  expect(response.results[0]).toMatchObject({
    pr: "https://github.com/acme/project/pull/42",
    retired: false,
  });
});

it("retains verification payloads for dependency candidates deferred to the next batch", () => {
  for (let i = 0; i < 4; i++) {
    const other = join(workspace, "zzz-other-" + i);
    execFileSync("git", ["clone", repo, other], { stdio: "pipe" });
    const packages = install(join(other, "node_modules"), 43 + i);
    put(
      join(other, "package-lock.json"),
      JSON.stringify({ lockfileVersion: 3, packages }),
    );
    execFileSync(
      "git",
      [
        "-C",
        other,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "-am",
        "different registry payload",
      ],
      { stdio: "pipe" },
    );
  }
  const first = run({ maxCacheFiles: 256 });
  const second = run({ maxCacheFiles: 256 });
  expect(
    first.filter((row: any) => row.kind === "dependencies" && row.removed),
  ).toHaveLength(4);
  expect(
    second.some((row: any) => row.kind === "dependencies" && row.removed),
  ).toBe(true);
  expect(existsSync(join(workspace, "zzz-other-3", "node_modules"))).toBe(
    false,
  );
});

it("keeps package payloads referenced by another workspace batch", () => {
  const otherKey = "b".repeat(64);
  const other = managedWorkspace(home, otherKey);
  const target = join(other, "repo");
  execFileSync("git", ["clone", repo, target], { stdio: "pipe" });
  install(join(target, "node_modules"));
  expect(
    run({ maxCacheFiles: 256 }).some(
      (row: any) => row.reason === "Payload is needed by retained dependencies",
    ),
  ).toBe(true);
  expect(
    run({ workspaceKeys: [otherKey], maxCacheFiles: 256 }).some(
      (row: any) => row.kind === "dependencies" && row.removed,
    ),
  ).toBe(true);
});
it("rejects recent dependencies before inspecting an invalid payload", () => {
  managedWorkspace(home, key, true);
  put(join(modules, "pkg", "index.js"), "changed local content");
  expect(run({ now: Date.now() })[0].reason).toBe("Recently used dependencies");
});
it("records use best-effort when a workspace has been relocated", () => {
  const other = join(home, "relocated");
  mkdirSync(other);
  const otherKey = "c".repeat(64);
  symlinkSync(other, join(home, "workspaces", otherKey));
  expect(managedWorkspace(home, otherKey, true)).toBe(
    join(home, "workspaces", otherKey),
  );
  expect(readdirSync(other)).toEqual([]);
});
it("visits mixed-case dependency paths fairly across bounded passes", () => {
  const names = ["apple", "Banana", "carrot", "Date", "egg", "Fig"];
  for (const name of names) {
    const target = join(workspace, name);
    execFileSync("git", ["clone", repo, target], { stdio: "pipe" });
    install(join(target, "node_modules"));
    put(join(target, "source.ts"), "keep local work");
  }
  const visited = new Set<string>();
  for (let i = 0; i < 4; i++)
    for (const row of run({ maxDependencies: 2 })) visited.add(row.path);
  for (const name of names)
    expect(visited.has(`workspaces/${key}/${name}/node_modules`)).toBe(true);
});

it("starts bounded cache discovery after its persisted shard cursor", () => {
  put(
    join(home, ".loop-storage/checked.json"),
    JSON.stringify({
      version: 2,
      batches: {},
      caches: { "npm-discovery": "fe/ff" },
    }),
  );
  const path = join(
    home,
    ".npm/_cacache/content-v2/sha512/ff/00",
    "a".repeat(124),
  );
  put(path, "unverified fixture");
  for (let i = 0; i < 100; i++)
    mkdirSync(
      join(
        home,
        ".npm/_cacache/content-v2/sha512/00",
        i.toString(16).padStart(2, "0"),
      ),
      { recursive: true },
    );
  const start = Date.now();
  let ticks = 0;
  const clock = vi
    .spyOn(Date, "now")
    .mockImplementation(() => start + ++ticks * 10);
  try {
    const results = run({ maxDependencies: 0, maxCacheFiles: 256 });
    expect(
      results.some((row: any) =>
        row.path?.endsWith("ff/00/" + "a".repeat(124)),
      ),
    ).toBe(true);
    expect(existsSync(path)).toBe(true);
    const saved = JSON.parse(
      readFileSync(join(home, ".loop-storage/checked.json"), "utf8"),
    );
    expect(saved.caches["npm-discovery"]).not.toBe("fe/ff");
  } finally {
    clock.mockRestore();
  }
});

it.each(["pax", "gnu", "ustar"])(
  "accepts safe %s registry archives with a nonstandard top directory",
  (format) => {
    const packages = install(modules, 42, format, "fixture-pkg");
    put(
      join(repo, "package-lock.json"),
      JSON.stringify({ lockfileVersion: 3, packages }),
    );
    git("add", "package-lock.json");
    git("commit", "-m", "archive fixture");
    const result = run()[0];
    expect(result, JSON.stringify(result)).toMatchObject({
      eligible: true,
      removed: true,
    });
  },
);

it.each(["file-link", "directory-link", "bun", "pnpm"])(
  "unrelated %s does not block cache cleanup or remove verification payloads",
  (kind) => {
    const extra = join(workspace, "other");
    mkdirSync(extra);
    if (kind.endsWith("link")) {
      symlinkSync(
        kind === "file-link" ? join(repo, "source.ts") : repo,
        join(extra, "linked"),
      );
    } else {
      put(join(extra, "node_modules", kind, "index.js"), "preserve");
    }
    const content = Buffer.from("unused download");
    const hash = createHash("sha512").update(content).digest("hex");
    const path = join(
      home,
      ".npm/_cacache/content-v2/sha512",
      hash.slice(0, 2),
      hash.slice(2, 4),
      hash.slice(4),
    );
    put(path, content.toString());
    const results = run({ maxDependencies: 0, maxCacheFiles: 256 });
    expect(
      results.find((r: { path: string }) => r.path.endsWith(hash.slice(4))),
    ).toMatchObject({ removed: true });
    expect(existsSync(modules)).toBe(true);
    const receipt = JSON.parse(
      readFileSync(join(modules, ".package-lock.json"), "utf8"),
    );
    const needed = Buffer.from(
      receipt.packages["node_modules/pkg"].integrity.split("-")[1],
      "base64",
    ).toString("hex");
    expect(
      existsSync(
        join(
          home,
          ".npm/_cacache/content-v2/sha512",
          needed.slice(0, 2),
          needed.slice(2, 4),
          needed.slice(4),
        ),
      ),
    ).toBe(true);
  },
);
