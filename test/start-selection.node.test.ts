import test from "node:test";
import assert from "node:assert/strict";
import { selectedHarnesses } from "../src/start-selection.js";

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
