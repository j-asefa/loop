import { accessSync, constants, statSync } from "node:fs";

// Read only the configured executable and the runner's native credential store.
// Never return executable paths, raw status output or credential material.
export async function runtimeInventory({ providers, binary, authStatus }) {
  const runtimes = [];
  for (const flavor of ["codex", "claude", "opencode", "pi"]) {
    if (providers && !providers.includes(flavor)) continue;
    let installed = false;
    try {
      const path = binary(flavor);
      accessSync(path, constants.X_OK);
      installed = statSync(path).isFile();
    } catch {}
    let authentication = "unknown";
    if (installed) {
      try {
        const auth = await authStatus(flavor);
        const fresh =
          Number.isFinite(auth.checkedAt) &&
          Date.now() - auth.checkedAt <= 30000 &&
          auth.checkedAt <= Date.now() + 5000;
        if (
          fresh &&
          auth.managed === true &&
          auth.authMethod === (flavor === "pi" ? "existing" : flavor === "claude" ? "claude" : "chatgpt")
        ) {
          if (
            auth.authenticated === true &&
            (flavor !== "opencode" ||
              auth.executionGuard === "loop-subscription-v1")
          ) authentication = "signed_in";
          else if (auth.authenticated === false) authentication = "signed_out";
        }
      } catch {}
    }
    runtimes.push({
      flavor,
      installed,
      authentication,
      billing: flavor === "pi"
        ? "Existing billing; uses your configured Pi provider"
        : "Native account required; API fallback disabled",
      checkedAt: Date.now(),
    });
  }
  return { runtimes };
}
