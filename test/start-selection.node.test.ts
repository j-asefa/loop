import test from "node:test";
import assert from "node:assert/strict";
import { automaticManagedStart } from "../src/start-selection.js";

test("plain start prepares managed execution without overriding explicit or saved choices", () => {
  assert.equal(automaticManagedStart("start", {}, {}), true);
  for (const options of [
    { direct: true },
    { providers: "both" },
    { execution: "docker" },
  ])
    assert.equal(automaticManagedStart("start", options, {}), false);
  for (const preferences of [{ providers: "both" }, { execution: "native" }])
    assert.equal(automaticManagedStart("start", {}, preferences), false);
  for (const action of ["codex", "claude", "opencode", "pi", "acp", "laptop"])
    assert.equal(automaticManagedStart(action, {}, {}), false);
});
