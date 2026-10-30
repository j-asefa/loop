import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnNative } from "../src/native-spawn.js";

for (const explicit of [false, true]) {
  test(`project code launched by a native harness cannot inherit the live database (${explicit ? "explicit" : "default"} environment)`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-native-environment-"));
    const live = join(dir, "live");
    const project = join(dir, "project");
    mkdirSync(live);
    mkdirSync(project);
    writeFileSync(join(live, "migration-sentinel"), "unchanged");
    const injected: NodeJS.ProcessEnv = {
      BETTER_AUTH_SECRET: "fixture-server-auth",
      OPENAI_API_KEY: "fixture-provider-key",
      CLAUDE_CONFIG_DIR: join(dir, "native-credentials"),
    };
    for (const prefix of ["LOOP_", "LOOP55_"]) {
      Object.assign(injected, {
        [prefix + "HOME"]: live,
        [prefix + "DATA_DIR"]: live,
        [prefix + "PROFILE"]: "companion",
        [prefix + "SERVICE"]: "systemd",
        [prefix + "ENCRYPTION_KEY"]: "fixture-encryption",
        [prefix + "GATEWAY_TOKEN"]: "fixture-gateway",
        [prefix + "EXECUTION_GENERATION"]: "fixture-generation",
        [prefix + "MEMORY_ENABLED"]: "0",
        [prefix + "TOOLS_URL"]: "http://127.0.0.1/fixture-tools",
        [prefix + "TOOLS_TOKEN"]: "fixture-scoped-tool",
        [prefix + "BILLING_MODE"]: "existing",
        [prefix + "TEST_SETTING"]: "fixture-control",
      });
    }
    const saved = new Map(
      Object.keys(injected).map((key) => [key, process.env[key]]),
    );
    const env = { ...process.env, ...injected };
    let child: ReturnType<typeof spawnNative> | undefined;
    try {
      Object.assign(process.env, injected);
      try {
        child = spawnNative(
          process.execPath,
          [
            "--import",
            import.meta.resolve("tsx"),
            "--input-type=module",
            "-e",
            `import { config } from ${JSON.stringify(new URL("../src/server/config.ts", import.meta.url).href)};
           import { writeFileSync, writeSync } from 'node:fs';
           import { join } from 'node:path';
           writeFileSync(join(config.data,'migration-sentinel'),'isolated');
           writeSync(3,'metadata pipe preserved');
           console.log(JSON.stringify({
             data:config.data,
             keys:Object.keys(process.env).filter(k=>/^LOOP(?:55)?_/.test(k)||k==='BETTER_AUTH_SECRET').sort(),
             providerPreserved:process.env.OPENAI_API_KEY==='fixture-provider-key',
             credentialHome:process.env.CLAUDE_CONFIG_DIR,
             home:process.env.HOME,
             tool:process.env.LOOP_TOOLS_TOKEN==='fixture-scoped-tool',
             billing:process.env.LOOP_BILLING_MODE,
           }));`,
          ],
          {
            cwd: project,
            ...(explicit ? { env } : {}),
            stdio: ["ignore", "pipe", "pipe", "pipe"],
          },
        );
      } finally {
        for (const [key, value] of saved) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
      let output = "",
        errors = "",
        metadata = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (errors += chunk));
      child.stdio[3]?.on("data", (chunk) => (metadata += chunk));
      const [code, signal] = await once(child, "close");
      assert.equal(code, 0, errors);
      assert.equal(signal, null);
      const actual = JSON.parse(output);
      assert.equal(actual.data, join(project, "data"));
      assert.equal(
        readFileSync(join(live, "migration-sentinel"), "utf8"),
        "unchanged",
      );
      assert.equal(
        readFileSync(join(project, "data/migration-sentinel"), "utf8"),
        "isolated",
      );
      assert.deepEqual(
        actual.keys,
        [
          ...["LOOP_", "LOOP55_"].flatMap((prefix) =>
            ["TOOLS_URL", "TOOLS_TOKEN", "BILLING_MODE", "TEST_SETTING"].map(
              (suffix) => prefix + suffix,
            ),
          ),
          "LOOP_HEAVY_SCHEDULING",
          ...Object.keys(process.env).filter(
            (key) => /^LOOP(?:55)?_TEST_/.test(key) && !(key in injected),
          ),
        ].sort(),
      );
      assert.equal(actual.providerPreserved, true);
      assert.equal(actual.credentialHome, injected.CLAUDE_CONFIG_DIR);
      assert.equal(actual.home, process.env.HOME);
      assert.equal(actual.tool, true);
      assert.equal(actual.billing, "existing");
      assert.equal(metadata, "metadata pipe preserved");
      assert.equal(
        env.LOOP_DATA_DIR,
        live,
        "caller environment stays unchanged",
      );
    } finally {
      child?.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
