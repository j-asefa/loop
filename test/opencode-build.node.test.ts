import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// @ts-expect-error Plain Node build utility is shipped without declarations.
import { modelsSnapshot, stage } from "../native/build-opencode.mjs";

test("guarded build accepts the pinned catalog and rejects altered bytes", () => {
  const bytes = readFileSync(
    new URL("../native/opencode-models.json.gz", import.meta.url),
  );
  assert.ok(
    Object.keys(JSON.parse(modelsSnapshot(bytes).toString()).openai.models)
      .length > 0,
  );
  const changed = Buffer.from(bytes);
  changed[20] ^= 1;
  assert.throws(() => modelsSnapshot(changed), /checksum mismatch/);
});

test("build stages reject failure and deadline expiry", async () => {
  await assert.rejects(
    stage(process.execPath, ["-e", "process.exit(2)"], process.cwd(), {}, 5),
    /failed/,
  );
  await assert.rejects(
    stage(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      process.cwd(),
      {},
      0.1,
    ),
    /timed out/,
  );
});
