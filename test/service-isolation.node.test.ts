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
  const home = await mkdtemp(join(tmpdir(), "loop-service-isolation-"));
  const mac = process.platform === "darwin";
  const dir = join(home, mac ? "Library/LaunchAgents" : ".config/systemd/user");
  const bin = join(home, "bin");
  try {
    await mkdir(dir, { recursive: true });
    await mkdir(bin);
    for (const name of ["systemctl", "launchctl"])
      await writeFile(join(bin, name), "#!/bin/sh\nexit 91\n", { mode: 0o755 });
    const units = serviceDefinitions(process.platform, process.execPath, "/production/dist/cli.js", join(home, "production"), home, process.env.PATH!);
    const saved = [];
    for (const unit of [units.app, units.connection]) {
      if (!unit) continue;
      const path = join(dir, mac ? `${unit.name}.plist` : unit.name);
      await writeFile(path, unit.contents);
      saved.push({ path, contents: unit.contents });
    }
    const module = pathToFileURL(resolve("src/service.ts")).href;
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      `import { repointAppService } from ${JSON.stringify(module)}; console.log(await repointAppService('/fixture/dist/cli.js', ${JSON.stringify(join(home, "fixture"))}));`,
    ], { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(stdout.trim(), "absent");
    for (const unit of saved) assert.equal(await readFile(unit.path, "utf8"), unit.contents);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
