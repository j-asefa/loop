import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  symlink,
  writeFile,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

for (const stamped of [true, false])
  test(
    `connection bundle uses ${stamped ? "the shared build stamp" : "the standalone package release"}`,
    { timeout: 20000 },
    async (t) => {
      const dir = await mkdtemp(join(tmpdir(), "loop-build-stamp-"));
      t.after(() => rm(dir, { recursive: true, force: true }));
      await symlink(resolve("src"), join(dir, "src"), "dir");
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ version: "fixture-package" }),
      );
      const stampFile = join(dir, "stamp.json");
      await writeFile(
        stampFile,
        JSON.stringify({
          id: "fixture-build",
          release: "fixture-stamp",
          repository: null,
          commit: null,
          clean: false,
          builtAt: 1,
          ancestors: [],
        }),
      );
      const env = { ...process.env };
      delete env.LOOP_BUILD_STAMP_FILE;
      if (stamped) env.LOOP_BUILD_STAMP_FILE = stampFile;
      execFileSync(
        process.execPath,
        [resolve("scripts/build-connection.mjs")],
        { cwd: dir, env, stdio: "pipe" },
      );
      const state = join(dir, "state");
      await mkdir(state);
      const config = join(dir, "tunnel.yml");
      await writeFile(config, "{}\n");
      const child = spawn(
        process.execPath,
        [
          join(dir, "dist/connection-daemon.bundle.mjs"),
          "--dir",
          state,
          "--root",
          state,
          "--tunnel-name",
          "fixture",
          "--public-url",
          "https://fixture.example",
          "--tunnel-config",
          config,
        ],
        {
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          env: {
            ...env,
            LOOP_TEST_CLOUDFLARED: resolve(
              "test/fixtures/fake-cloudflared.mjs",
            ),
          },
        },
      );
      const exit = once(child, "exit");
      try {
        const [message] = await once(child, "message");
        assert.equal(message.ready, true, JSON.stringify(message));
        const record = JSON.parse(
          await readFile(join(state, "connection.json"), "utf8"),
        );
        assert.equal(
          record.version,
          stamped ? "fixture-stamp" : "fixture-package",
        );
      } finally {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGTERM");
        await exit;
      }
    },
  );
