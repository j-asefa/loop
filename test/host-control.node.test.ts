import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { discover } from "../src/host-control.js";
const exec = promisify(execFile);

const versions = {
  gemini: {
    minimum: "0.64.0",
    older: "0.63.0",
    latest: "0.65.0",
    format: (v: string) => `${v}\n`,
  },
  codex: {
    minimum: "0.157.0",
    older: "0.156.99",
    latest: "0.159.0",
    format: (v: string) => `codex-cli ${v}\n`,
  },
  claude: {
    minimum: "2.1.237",
    older: "2.1.236",
    latest: "2.1.284",
    format: (v: string) => `${v} (Claude Code)\n`,
  },
  pi: {
    minimum: "0.87.1",
    older: "0.87.0",
    latest: "0.87.1",
    format: (v: string) => `${v}\n`,
  },
  opencode: {
    minimum: "1.18.32",
    older: "1.18.31",
    latest: "1.18.33",
    format: (v: string) => `${v}\n`,
  },
};

test("harness discovery admits stable upgrades and rejects unsupported versions", async (t) => {
  await mkdir(".tmp", { recursive: true });
  const dir = await mkdtemp(join(resolve(".tmp"), "loop-discovery-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fixture = async (name: string, output: string, exitCode = 0) => {
    const executable = join(dir, name);
    await writeFile(
      executable,
      `#!/usr/bin/env node\nif (process.argv[2] !== "--version") process.exit(90);\nprocess.stdout.write(${JSON.stringify(output)});\nprocess.exit(${exitCode});\n`,
      { mode: 0o755 },
    );
    return executable;
  };

  for (const name of Object.keys(versions) as (keyof typeof versions)[]) {
    const { minimum, older, latest, format } = versions[name];
    await t.test(name, async () => {
      const [major, minor, patch] = minimum.split(".").map(Number);
      for (const version of new Set([
        minimum,
        latest,
        `${major}.${minor}.${patch + 1}`,
        `${major}.${minor + 1}.0`,
        `${major + 1}.0.0`,
        `${major}.${minor}.${patch}+local.1`,
      ])) {
        const executable = await fixture(name, format(version));
        const found = await discover(name, executable);
        assert.equal(found.installed, true);
        assert.equal(found.supported, true, version);
        assert.equal(found.version, version);
        assert.equal(found.help, "");
      }
      for (const version of [
        older,
        `${minimum}-rc.1`,
        `${major + 1}.0.0-beta.1`,
      ]) {
        const found = await discover(
          name,
          await fixture(name, format(version)),
        );
        assert.equal(found.installed, true);
        assert.equal(found.supported, false, version);
        assert.equal(found.version, version);
        assert(found.help.includes(`>= ${minimum}`));
        assert.match(found.help, /stable/);
      }
      const found = await discover(
        name,
        await fixture(name, format(`v${latest}`)),
      );
      assert.equal(found.supported, true);
      assert.equal(found.version, latest);
    });
  }

  await t.test(
    "malformed and failed version commands do not become available",
    async () => {
      for (const output of [
        "unknown",
        "0.159",
        "00.159.0",
        "0.159.0.1",
        "0.159.0+..",
        "0.159.0-canary..1",
        "9007199254740992.0.0",
      ]) {
        const found = await discover("codex", await fixture("codex", output));
        assert.equal(found.installed, true);
        assert.equal(found.supported, false, output);
        assert.match(found.help, /Requires a stable codex version/);
      }
      const failed = await discover(
        "codex",
        await fixture("codex", "0.159.0", 1),
      );
      assert.equal(failed.supported, false);
      assert.match(failed.help, /failed --version/);
      assert.equal(
        (await discover("pi", join(dir, "absent"))).installed,
        false,
      );
    },
  );

  await t.test(
    "doctor reports new stable releases without trying to auto-discover ACP",
    async () => {
      for (const [name, { latest, format }] of Object.entries(versions)) {
        await fixture(name, format(latest));
      }
      const { stdout } = await exec(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", "doctor", "--json"],
        {
          env: {
            ...process.env,
            LOOP_HOME: join(dir, "state"),
            PATH: dir + ":" + process.env.PATH,
          },
          timeout: 15000,
        },
      );
      const report = JSON.parse(stdout);
      assert.equal(report.harnesses.length, Object.keys(versions).length);
      for (const [name, { latest }] of Object.entries(versions)) {
        const harness = report.harnesses.find(
          (h: { name: string }) => h.name === name,
        );
        assert.equal(harness?.supported, true, name);
        assert.equal(harness.version, latest);
      }
      assert(!report.checks.some((check: string) => check.includes("HAPI")));
    },
  );
});
