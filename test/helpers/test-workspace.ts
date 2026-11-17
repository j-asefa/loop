import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const owned = new Map<string, string>();

export function createTestWorkspace(prefix = "loop-test-") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const directory = join(root, "data");
  try {
    // Match config.ts: pre-creating data must retain its private mode.
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  owned.set(directory, root);
  return {
    root,
    directory,
    encryptionKey: randomBytes(32).toString("hex"),
    close() {
      rmSync(root, { recursive: true, force: true });
      owned.delete(directory);
    },
  };
}

/** Vitest setup owns this directory; files still close their own resources. */
export function testDirectory() {
  const directory = process.env.LOOP_DATA_DIR;
  if (!directory || !owned.has(directory))
    throw new Error("The test workspace setup has not run");
  return directory;
}

/** Sibling harness homes and projects share the setup-owned root. */
export function testRootDirectory() {
  return owned.get(testDirectory())!;
}
