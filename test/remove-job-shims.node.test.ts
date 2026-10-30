import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { removeJobShims } from "../deployment/remove-job-shims.mjs";
import { shimScript } from "../deployment/job-shim.mjs";

test("retired wrappers run immediately with stale settings, preserving argv, PID and protocol pipes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-retired-shims-"));
  const config = join(dir, "jobs.json");
  try {
    writeFileSync(
      config,
      JSON.stringify({
        shims: dir,
        commands: {
          node: process.execPath,
          npm: process.execPath,
          npx: process.execPath,
        },
      }),
    );
    for (const name of ["node", "npm", "npx"])
      writeFileSync(
        join(dir, name),
        shimScript(
          config,
          process.execPath,
          resolve("deployment/job-shim.mjs"),
          name,
          process.execPath,
        ),
        { mode: 0o700 },
      );
    assert.deepEqual(await removeJobShims(config), ["node", "npm", "npx"]);
    assert.deepEqual(await removeJobShims(config), []);
    for (const name of ["node", "npm", "npx"]) {
      const child = spawn(
        join(dir, name),
        [
          "-e",
          `
        const assert=require('assert/strict');
        assert.equal(process.argv[1], "space ' $literal");
        for (const key of ['LOOP_JOB_QUEUE_CONFIG','LOOP_JOB_SHIMS','LOOP_JOB_ACTIVE'])
          assert.equal(process.env[key],undefined);
        assert.equal(process.env.LOOP_HEAVY_SCHEDULING,'off');
        require('fs').writeSync(3,String(process.pid));
        process.exit(7);
      `,
          "space ' $literal",
        ],
        {
          env: {
            ...process.env,
            LOOP_JOB_QUEUE_CONFIG: "/missing/config.json",
            LOOP_JOB_SHIMS: dir,
            LOOP_JOB_ACTIVE: "old",
            LOOP_HEAVY_SCHEDULING: "on",
          },
          stdio: ["ignore", "ignore", "pipe", "pipe"],
        },
      );
      let protocol = "",
        errors = "";
      (child.stdio[3] as import("node:stream").Readable).on(
        "data",
        (data) => (protocol += data),
      );
      child.stderr!.on("data", (data) => (errors += data));
      const [code] = await once(child, "close");
      assert.equal(code, 7, errors);
      assert.equal(Number(protocol), child.pid);
    }
    // Removing the queue config does not break already-inherited PATH wrappers.
    rmSync(config);
    assert.equal(
      spawnSync(join(dir, "node"), ["-e", "process.exit(0)"]).status,
      0,
    );
    assert.deepEqual(await removeJobShims(config), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wrapper retirement leaves custom commands and other wrappers untouched on validation failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-custom-shims-"));
  const config = join(dir, "jobs.json");
  try {
    writeFileSync(
      config,
      JSON.stringify({ shims: dir, commands: { node: process.execPath } }),
    );
    const original = shimScript(
      config,
      process.execPath,
      resolve("deployment/job-shim.mjs"),
      "node",
      process.execPath,
    );
    writeFileSync(join(dir, "node"), original, { mode: 0o700 });
    writeFileSync(join(dir, "npm"), "#!/bin/sh\necho custom\n", {
      mode: 0o700,
    });
    await assert.rejects(
      removeJobShims(config),
      /Unrecognized command wrapper/,
    );
    assert.equal(readFileSync(join(dir, "node"), "utf8"), original);
    assert.equal(
      readFileSync(join(dir, "npm"), "utf8"),
      "#!/bin/sh\necho custom\n",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
