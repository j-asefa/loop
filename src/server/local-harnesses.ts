import { nativeConnectionId, harnesses } from "../shared/harnesses.js";
import * as connectionsQueries from "./sql/connections.js";
import { executionRequest } from "./execution-client.js";
import { writeConnectionStatus } from "./connection-status.js";
import { discover } from "../host-control.js";
import { setRuntimeSetupState } from "../runtime-setup.js";
import type { Harness } from "../protocol.js";
import { db } from "./db.js";
import { nativeSessions, OWNER } from "./native-sessions.js";

/** Discover and verify each harness independently. Never makes a model request. */
export async function prepareLocalHarnesses(
  project: string,
  names: Harness[],
  stopping: () => boolean = () => false,
) {
  setRuntimeSetupState("preparing");
  const registered = nativeSessions.registrations();
  // Custom ACP executables are never discovered from browser input. Restore only
  // an existing desktop registration.
  const selected = [
    ...new Set([
      ...names,
      ...registered.filter((r) => r.name === "acp").map((r) => r.name),
    ]),
  ];
  let enabled = 0;
  for (const name of selected) {
    if (stopping()) break;
    const connection = connectionsQueries.statusMetadata(
      db,
      nativeConnectionId(name),
      OWNER,
    ) as { status: string; metadata: string } | undefined;
    // An intentional disconnect is not an invitation to sign in again.
    if (connection?.status === "disconnected") continue;
    const saved = nativeSessions.savedRegistration(name);
    try {
      const probe =
        name === "acp" && saved
          ? { installed: true, supported: true, ...saved }
          : await discover(name, saved?.executable);
      if (
        !probe.installed ||
        !probe.supported ||
        !probe.executable ||
        !probe.version
      ) {
        if (connection) throw new Error("Saved harness unavailable");
        continue;
      }
      await executionRequest("runtime.register", {
        options: saved
          ? { ...saved, executable: probe.executable, version: probe.version }
          : {
              harness: name,
              executable: probe.executable,
              version: probe.version,
              project,
              billing: harnesses[name].billing.default,
            },
      });
      enabled++;
    } catch {
      // Never print provider configuration, credentials or raw auth subprocess output.
      // Verification failure must not leave a stale account available for dispatch.
      writeConnectionStatus(nativeConnectionId(name), () =>
        connectionsQueries.needsSignIn(db, nativeConnectionId(name), OWNER),
      );
      console.log(
        `${name}: check installation and sign-in in Provider connections.`,
      );
    }
  }
  setRuntimeSetupState(stopping() ? "stopped" : "ready");
  return {
    billing: {
      description: `${enabled} native harness${enabled === 1 ? "" : "es"} ready. Manage installation and sign-in in Provider connections.`,
    },
  };
}
