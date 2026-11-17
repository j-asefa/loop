import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const owned = new Set<string>();

export function createTestWorkspace(prefix = "loop-test-") {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  owned.add(directory);
  return {
    directory,
    encryptionKey: randomBytes(32).toString("hex"),
    close() {
      rmSync(directory, { recursive: true, force: true });
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
