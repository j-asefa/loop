// Run with node --import tsx against a patched pinned HAPI checkout.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

if (!process.argv[2]) throw new Error("Provide the patched HAPI checkout");
const { getAgentLaunchCommand } = await import(
  pathToFileURL(resolve(process.argv[2], "cli/src/agent/agentLaunchCommand.ts"))
);
const executable = "/private/guarded runtime/opencode";
assert.equal(
  getAgentLaunchCommand("opencode", {
    LOOP_MANAGED: "1",
    HAPI_OPENCODE_PATH: executable,
    PATH: "/unrelated/bin",
  }),
  executable,
);
for (const value of [undefined, "", "opencode", "./opencode"])
  assert.throws(() =>
    getAgentLaunchCommand("opencode", {
      LOOP_MANAGED: "1",
      HAPI_OPENCODE_PATH: value,
    }),
  );
assert.equal(
  getAgentLaunchCommand("opencode", { HAPI_OPENCODE_PATH: executable }),
  "opencode",
);
const piExecutable = "/private/native runtime/pi";
assert.equal(
  getAgentLaunchCommand("pi", {
    LOOP_MANAGED: "1",
    HAPI_PI_PATH: piExecutable,
    PATH: "/unrelated/bin",
  }),
  piExecutable,
);
for (const value of [undefined, "", "pi", "./pi"])
  assert.throws(() =>
    getAgentLaunchCommand("pi", { LOOP_MANAGED: "1", HAPI_PI_PATH: value }),
  );
assert.equal(getAgentLaunchCommand("pi", { HAPI_PI_PATH: piExecutable }), "pi");
console.log("PASS: managed executable pinning and unchanged unmanaged resolution");
