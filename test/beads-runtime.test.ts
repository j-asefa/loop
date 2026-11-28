import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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
