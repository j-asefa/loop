import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { serviceDefinitions } from "../src/service.js";

test("an upgrade cannot repoint another workspace's application or connection service", async () => {
  const home = await mkdtemp(join(tmpdir(), "loop55-service-isolation-"));
  const mac = process.platform === "darwin";
  const dir = join(home, mac ? "Library/LaunchAgents" : ".config/systemd/user");
  const bin = join(home, "bin");
  try {
    await mkdir(dir, { recursive: true });
    await mkdir(bin);
    for (const name of ["systemctl", "launchctl"])
      await writeFile(join(bin, name), "#!/bin/sh\nexit 91\n", { mode: 0o755 });
    const units = serviceDefinitions(
      process.platform,
      process.execPath,
      "/production/dist/cli.js",
      join(home, "production"),
      home,
      process.env.PATH!,
    );
    const saved = [];
    for (const unit of [units.app, units.connection]) {
      if (!unit) continue;
      const path = join(dir, mac ? `${unit.name}.plist` : unit.name);
      await writeFile(path, unit.contents);
      saved.push({ path, contents: unit.contents });
    }
    const module = pathToFileURL(resolve("src/service.ts")).href;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import { repointAppService } from ${JSON.stringify(module)}; console.log(await repointAppService('/fixture/dist/cli.js', ${JSON.stringify(join(home, "fixture"))}));`,
      ],
      {
        env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
      },
    );
    assert.equal(stdout.trim(), "absent");
    for (const unit of saved)
      assert.equal(await readFile(unit.path, "utf8"), unit.contents);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("legacy service discovery remains bound to its configured home", async () => {
  const home = await mkdtemp(join(tmpdir(), "loop55-legacy-service-"));
  const mac = process.platform === "darwin";
  const dir = join(home, mac ? "Library/LaunchAgents" : ".config/systemd/user");
  const root = join(home, 'workspace "quoted"');
  try {
    await mkdir(dir, { recursive: true });
    const units = serviceDefinitions(
      process.platform,
      process.execPath,
      "/old/dist/cli.js",
      root,
      home,
      process.env.PATH!,
    );
    for (const unit of [units.app, units.connection]) {
      if (!unit) continue;
      const name = unit.name.replace("loop55", "loop");
      const contents = unit.contents
        .replaceAll("LOOP55_", "LOOP_")
        .replaceAll("dev.loop55.", "dev.loop.")
        .replaceAll("loop55.service", "loop.service")
        .replaceAll("loop55-connection.service", "loop-connection.service");
      await writeFile(join(dir, mac ? `${name}.plist` : name), contents);
    }
    const module = pathToFileURL(resolve("src/service.ts")).href;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import { installedServiceNames } from ${JSON.stringify(module)}; console.log(JSON.stringify({ own: await installedServiceNames(${JSON.stringify(root)}), foreign: await installedServiceNames(${JSON.stringify(join(home, "another"))}) ?? null }));`,
      ],
      { env: { ...process.env, HOME: home } },
    );
    assert.deepEqual(JSON.parse(stdout), {
      own: mac
        ? { app: "dev.loop.workspace", connection: "dev.loop.connection" }
        : { app: "loop.service", connection: "loop-connection.service" },
      foreign: null,
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
