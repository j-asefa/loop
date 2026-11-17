import { afterAll, expect, it } from "vitest";
import {
  appendFileSync,
  existsSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { threadId } from "node:worker_threads";
import { testDirectory } from "../helpers/test-workspace.js";

export function bootstrapProbe(label: string) {
  const directory = testDirectory();
  const marker = join(directory, "owned-resource");
  it("owns a fresh directory and key before test-file imports", () => {
    expect(readdirSync(directory)).toEqual([]);
    const key = process.env.LOOP_ENCRYPTION_KEY!;
    expect(key).toMatch(/^[a-f\d]{64}$/);
    writeFileSync(marker, label);
    appendFileSync(
      process.env.LOOP_TEST_BOOTSTRAP_OBSERVATIONS!,
      JSON.stringify({
        label,
        directory,
        keyHash: createHash("sha256").update(key).digest("hex"),
        pid: process.pid,
        threadId,
      }) + "\n",
    );
  });
  afterAll(() => {
    expect(
      existsSync(marker),
      "File cleanup runs before workspace cleanup",
    ).toBe(true);
  });
}
