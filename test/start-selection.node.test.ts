import test from "node:test";
import assert from "node:assert/strict";
import { selectedHarnesses } from "../src/start-selection.js";
import { migrateLaunchArgs } from "../src/service.js";

test("one launch selects all installed harnesses, with explicit opt-in subsets", () => {
  assert.deepEqual(selectedHarnesses(), [
    "codex",
    "claude",
    "pi",
    "opencode",
    "antigravity",
    "muse",
    "grok",
  ]);
  assert.deepEqual(selectedHarnesses("antigravity,codex"), [
    "antigravity",
    "codex",
  ]);
  assert.deepEqual(selectedHarnesses("gemini,codex"), ["gemini", "codex"]);
  assert.deepEqual(selectedHarnesses("both"), ["codex", "claude"]);
  assert.deepEqual(selectedHarnesses("pi,codex,pi"), ["pi", "codex"]);
  assert.throws(() => selectedHarnesses("acp"), /Register custom ACP/);
});
test("saved HAPI launcher options migrate to native while retaining project and pairing settings", () => {
  assert.deepEqual(
    migrateLaunchArgs([
      "start",
      "--providers",
      "both",
      "--execution",
      "docker",
      "--project",
      "/project",
      "--public-url",
      "https://loop55.example",
    ]),
    [
      "start",
      "--providers",
      "both",
      "--project",
      "/project",
      "--public-url",
      "https://loop55.example",
      "--execution",
      "native",
    ],
  );
  assert.deepEqual(
    migrateLaunchArgs([
      "laptop",
      "--billing=existing",
      "--executable",
      "/old",
      "--local-only",
    ]),
    ["start", "--local-only", "--execution", "native"],
  );
  const args = [
    "acp",
    "--executable",
    "/custom",
    "--acp-arg",
    "serve",
    "--billing",
    "existing",
  ];
  assert.deepEqual(migrateLaunchArgs(args), args);
});
