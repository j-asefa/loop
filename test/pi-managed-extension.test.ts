import { expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piManagedBinding } from "../native/pi-managed-extension";

it("reads only the launch-scoped Pi capability and rejects replaced identity or billing", () => {
  const home = mkdtempSync(join(tmpdir(), "loop-pi-binding-"));
  const file = join(home, "launch.json");
  const launchId = "11111111-1111-4111-8111-111111111111";
  const env = { LOOP_LAUNCH_FILE: file, LOOP_LAUNCH_ID: launchId, LOOP_ENVIRONMENT_GENERATION: "1" };
  const binding = { launchId, generation: 1, flavor: "pi", billing: { mode: "existing", requiredAuth: "pi", allowApiFallback: false }, gatewayUrl: "http://127.0.0.1/mcp", gatewayToken: "fixture-only" };
  try {
    writeFileSync(file, JSON.stringify(binding), { mode: 0o600 });
    expect(piManagedBinding(env)).toEqual({ gatewayUrl: binding.gatewayUrl, gatewayToken: binding.gatewayToken, generation: 1 });
    for (const change of [{ generation: 2 }, { flavor: "codex" }, { launchId: "different" }, { billing: { ...binding.billing, mode: "subscription" } }, { gatewayUrl: "https://user:pass@example.com" }, { gatewayToken: "secret\nheader" }]) {
      writeFileSync(file, JSON.stringify({ ...binding, ...change }));
      expect(() => piManagedBinding(env)).toThrow();
    }
    expect(() => piManagedBinding({ ...env, LOOP_LAUNCH_FILE: "relative.json" })).toThrow();
  } finally { rmSync(home, { recursive: true, force: true }); }
});
