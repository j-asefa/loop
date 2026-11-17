import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export async function verifyTestBootstrap() {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "loop-bootstrap-contract-")),
  );
  try {
    const external = join(directory, "external");
    mkdirSync(external);
    writeFileSync(join(external, "keep"), "untouched");
    const externalKey = "5a".repeat(32);
    for (const pool of ["forks", "threads"]) {
      const observations = join(directory, pool + ".jsonl");
      const config = join(directory, pool + ".config.mjs");
      const fixture = {
        root: process.cwd(),
        test: {
          include: [
            "test/fixtures/bootstrap-one.fixture.ts",
            "test/fixtures/bootstrap-two.fixture.ts",
          ],
          maxWorkers: 1,
          fileParallelism: false,
          isolate: true,
          pool,
        },
      };
      writeFileSync(
        config,
        `import base from ${JSON.stringify(resolve("vite.config.ts"))};
const fixture=${JSON.stringify(fixture)};
export default {...base,...fixture,test:{...base.test,...fixture.test}};`,
      );
      await exec(
        process.execPath,
        [resolve("node_modules/vitest/vitest.mjs"), "run", "--config", config],
        {
          env: {
            ...process.env,
            TMPDIR: directory,
            LOOP_DATA_DIR: external,
            LOOP_ENCRYPTION_KEY: externalKey,
            LOOP_TEST_BOOTSTRAP_OBSERVATIONS: observations,
          },
          timeout: 30000,
        },
      );
      const records = readFileSync(observations, "utf8")
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              label: string;
              directory: string;
              root: string;
              keyHash: string;
            },
        );
      assert.deepEqual(records.map((record) => record.label).sort(), [
        "one",
        "two",
      ]);
      assert.equal(new Set(records.map((record) => record.directory)).size, 2);
      assert.equal(new Set(records.map((record) => record.keyHash)).size, 2);
      for (const record of records) {
        assert.equal(dirname(record.root), directory);
        assert.equal(dirname(record.directory), record.root);
        assert.equal(
          existsSync(record.root),
          false,
          "Setup removes sibling resources with its root",
        );
        assert.notEqual(record.directory, external);
        assert.notEqual(
          record.keyHash,
          createHash("sha256").update(externalKey).digest("hex"),
        );
        assert.equal(
          existsSync(record.directory),
          false,
          "Setup removes its own directory after the file finishes",
        );
      }
      assert.deepEqual(readdirSync(external), ["keep"]);
      assert.equal(readFileSync(join(external, "keep"), "utf8"), "untouched");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
