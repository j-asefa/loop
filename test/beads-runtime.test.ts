import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { beadsBinary, beadsRelease } from "../src/beads-runtime.js";

const lock = fileURLToPath(
  new URL("../deployment/beads-locked.py", import.meta.url),
);

it("keeps the per-store lock after exec and releases it when the worker dies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loop-beads-lock-"));
  const children: ReturnType<typeof spawn>[] = [];
  function worker(script: string) {
    const child = spawn(
      "python3",
      [lock, "/usr/bin/env", "python3", "-c", script],
      {
        cwd: directory,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    children.push(child);
    return child;
  }
  try {
    const holder = worker(
      "import time; print('locked', flush=True); time.sleep(60)",
    );
    const held = once(holder.stdout!, "data");
    const holderExit = once(holder, "exit");
    let error = "";
    holder.stderr!.on("data", (chunk) => {
      error += chunk;
    });
    const started = await Promise.race([
      held.then(([chunk]) => String(chunk)),
      holderExit,
    ]);
    expect(started, error).toBe("locked\n");

    const waiter = worker("pass");
    const waiterExit = once(waiter, "exit");
    const signal = await Promise.race([
      waiterExit,
      new Promise((done) => setTimeout(() => done("waiting"), 250)),
    ]);
    expect(signal).toBe("waiting");

    holder.kill("SIGKILL");
    expect(await holderExit).toEqual([null, "SIGKILL"]);
    expect(await waiterExit).toEqual([0, null]);
  } finally {
    for (const child of children) child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects an invalid archive and refuses to use a tampered baked binary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loop-beads-install-"));
  const bakedRoot = join(directory, "baked");
  const baked = join(bakedRoot, "beads-runtime", beadsRelease);
  const installedRoot = join(directory, "installed");
  const realFetch = vi.fn(async () => new Response("not the pinned archive"));
  try {
    await mkdir(baked, { recursive: true });
    await writeFile(join(baked, "bd"), "#!/bin/sh\nexit 0", { mode: 0o700 });
    vi.stubEnv("LOOP_BAKED_BEADS", bakedRoot);
    vi.stubGlobal("fetch", realFetch);

    await expect(beadsBinary(installedRoot)).rejects.toThrow(
      "Beads archive integrity check failed",
    );
    expect(realFetch).toHaveBeenCalledOnce();
    expect(
      await readdir(join(installedRoot, "beads-runtime", beadsRelease)),
    ).toEqual([]);
  } finally {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  }
});

it("marks lock-open failures before executing the helper", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loop-beads-lock-failure-"));
  try {
    await mkdir(join(directory, ".loop-beads.lock"));
    const child = spawn("python3", [lock, "/bin/false"], {
      cwd: directory,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let error = "";
    child.stderr!.on("data", (chunk) => {
      error += chunk;
    });
    expect(await once(child, "close")).toEqual([1, null]);
    expect(error).toBe("LOOP_BEADS_NOT_STARTED\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("keeps the first verified binary when independent installers publish together", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loop-beads-publish-"));
  try {
    const content = "candidate executable";
    const digest = createHash("sha256").update(content).digest("hex");
    const destination = join(directory, "bd");
    const candidates = [join(directory, "first"), join(directory, "second")];
    await Promise.all(
      candidates.map((path) => writeFile(path, content, { mode: 0o700 })),
    );
    const inodes = await Promise.all(
      candidates.map(async (path) => (await stat(path)).ino),
    );
    const exits = await Promise.all(
      candidates.map((path) =>
        once(
          spawn("python3", [lock, "--install", path, destination, digest], {
            cwd: directory,
            stdio: "ignore",
          }),
          "close",
        ),
      ),
    );
    expect(exits).toEqual([
      [0, null],
      [0, null],
    ]);
    expect(inodes).toContain((await stat(destination)).ino);
    expect(
      (await readdir(directory)).filter(
        (name) => name === "first" || name === "second",
      ),
    ).toHaveLength(1);
    expect(await readFile(destination, "utf8")).toBe(content);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("repairs damaged cache entries and preserves an unexpected directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loop-beads-damaged-cache-"));
  const cache = join(directory, "beads-runtime", beadsRelease);
  const destination = join(cache, "bd");
  const candidate = join(cache, "candidate");
  const content = "verified candidate";
  const expected = createHash("sha256").update(content).digest("hex");
  try {
    await mkdir(cache, { recursive: true });
    await writeFile(destination, "unreadable helper", { mode: 0 });
    await writeFile(candidate, content, { mode: 0o700 });
    const publish = () =>
      once(
        spawn(
          "python3",
          [lock, "--install", candidate, destination, expected],
          {
            cwd: cache,
            stdio: "ignore",
            timeout: 1000,
          },
        ),
        "close",
      );
    expect(await publish()).toEqual([0, null]);
    expect(await readFile(destination, "utf8")).toBe(content);

    await rm(destination);
    expect(await once(spawn("mkfifo", [destination]), "close")).toEqual([
      0,
      null,
    ]);
    vi.stubGlobal("fetch", async () => new Response("bad archive"));
    await expect(beadsBinary(directory)).rejects.toThrow(
      "Beads archive integrity check failed",
    );
    await writeFile(candidate, content, { mode: 0o700 });
    expect(await publish()).toEqual([0, null]);
    expect(await readFile(destination, "utf8")).toBe(content);

    await rm(destination);
    await mkdir(destination);
    await writeFile(join(destination, "existing.txt"), "keep this");
    await writeFile(candidate, content, { mode: 0o700 });
    expect(await publish()).toEqual([0, null]);
    expect(await readFile(destination, "utf8")).toBe(content);
    const rejected = (await readdir(cache)).find((name) =>
      name.startsWith(".rejected-bd-"),
    );
    expect(rejected).toBeDefined();
    expect(
      await readFile(join(cache, rejected!, "bd", "existing.txt"), "utf8"),
    ).toBe("keep this");
  } finally {
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  }
});
