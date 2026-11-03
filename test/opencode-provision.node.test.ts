import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
// @ts-expect-error Shipped plain Node utility.
import { provisionOpencode } from "../native/provision-opencode.mjs";

test("private provisioning promotes successful builds, reuses cache and detects tampering", async () => {
  const root = mkdtempSync(join(tmpdir(), "loop-provision-test-"));
  const calls: string[][] = [];
  try {
    const run = async (command: string, args: string[]) => {
      calls.push([command, ...args]);
      if (args[0]?.endsWith("build-opencode.mjs")) {
        const binary = join(
          args[1],
          `packages/opencode/dist/opencode-${process.platform}-${process.arch}/bin/opencode`,
        );
        mkdirSync(dirname(binary), { recursive: true });
        writeFileSync(binary, "fixture binary");
      }
    };
    const binary = await provisionOpencode(root, run);
    assert.equal(readFileSync(binary, "utf8"), "fixture binary");
    assert.ok(calls.some((c) => c.includes("--depth=1")));
    assert.ok(calls.some((c) => c.includes("--version")));
    const count = calls.length;
    assert.equal(await provisionOpencode(root, run), binary);
    assert.equal(calls.length, count);
    const userRoot = join(root, "untouched-user-home");
    assert.equal(await provisionOpencode(userRoot, run, root), binary);
    assert.equal(calls.length, count);
    assert.equal(readdirSync(root).includes("untouched-user-home"), false);
    await assert.rejects(
      provisionOpencode(userRoot, run, join(root, "missing-image")),
      /missing or incompatible/,
    );
    assert.equal(calls.length, count);
    writeFileSync(binary, "changed");
    await assert.rejects(provisionOpencode(userRoot, run, root), /integrity/);
    assert.equal(readdirSync(root).includes("untouched-user-home"), false);
    await assert.rejects(provisionOpencode(root, run), /integrity/);
    assert.equal(calls.length, count);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed provisioning removes only its temporary build and preserves prior work", async () => {
  const root = mkdtempSync(join(tmpdir(), "loop-provision-failure-"));
  try {
    mkdirSync(join(root, "helpers"));
    writeFileSync(join(root, "helpers", "prior-work"), "preserved");
    await assert.rejects(
      provisionOpencode(root, async () => {
        throw new Error("fixture failure");
      }),
      /fixture failure/,
    );
    assert.deepEqual(readdirSync(join(root, "helpers")), ["prior-work"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
