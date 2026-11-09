import test from "node:test";
import assert from "node:assert/strict";
import { selectedHarnesses, selectedBilling } from "../src/start-selection.js";

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
  assert.deepEqual(selectedHarnesses("grok,codex"), ["grok", "codex"]);
  assert.deepEqual(selectedHarnesses("both"), ["codex", "claude"]);
  assert.deepEqual(selectedHarnesses("pi,codex,pi"), ["pi", "codex"]);
  assert.throws(() => selectedHarnesses("acp"), /Register custom ACP/);
});

test("Pi defaults to existing billing while explicit and saved subscription remain available", () => {
  assert.equal(selectedBilling("pi"), "existing");
  assert.equal(selectedBilling("pi", "subscription"), "subscription");
  assert.equal(
    selectedBilling("pi", undefined, "subscription"),
    "subscription",
  );
  assert.equal(selectedBilling("pi", "existing", "subscription"), "existing");
  assert.equal(selectedBilling("codex"), "subscription");
  assert.equal(
    selectedBilling("opencode"),
    "subscription",
    "retain the CLI consent step",
  );
});
