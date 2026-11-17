import { afterAll, expect, it } from "vitest";
import {
  appendFileSync,
  existsSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { threadId } from "node:worker_threads";
import { testDirectory, testRootDirectory } from "../helpers/test-workspace.js";

export function bootstrapProbe(label: string) {
  const directory = testDirectory();
  const root = testRootDirectory();
  const sibling = join(root, "sibling-resource");
  const marker = join(directory, "owned-resource");
  it("owns a fresh directory and key before test-file imports", () => {
    expect(readdirSync(directory)).toEqual([]);
    expect(dirname(directory)).toBe(root);
    expect(statSync(directory).mode & 0o077).toBe(0);
    expect(statSync(root).mode & 0o077).toBe(0);
    expect(readdirSync(root)).toEqual(["data"]);
    const originalDirectory = process.env.LOOP_DATA_DIR;
    try {
      process.env.LOOP_DATA_DIR = join(root, "not-owned");
      expect(() => testDirectory()).toThrow(/setup has not run/);
      expect(() => testRootDirectory()).toThrow(/setup has not run/);
    } finally {
      process.env.LOOP_DATA_DIR = originalDirectory;
    }
    writeFileSync(sibling, label);
    const key = process.env.LOOP_ENCRYPTION_KEY!;
    expect(key).toMatch(/^[a-f\d]{64}$/);
    writeFileSync(marker, label);
    appendFileSync(
      process.env.LOOP_TEST_BOOTSTRAP_OBSERVATIONS!,
      JSON.stringify({
        label,
        directory,
        root,
        keyHash: createHash("sha256").update(key).digest("hex"),
        pid: process.pid,
        threadId,
      }) + "\n",
    );
  });
  afterAll(() => {
    expect(existsSync(sibling)).toBe(true);
    expect(
      existsSync(marker),
      "File cleanup runs before workspace cleanup",
    ).toBe(true);
  });
}
