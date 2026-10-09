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
  // an existing desktop registration, including one retired by migration 067.
  const selected = [
    ...new Set([
      ...names,
      ...registered.filter((r) => r.name === "acp").map((r) => r.name),
    ]),
  ];
  let enabled = 0;
  for (const name of selected) {
    if (stopping()) break;
    const connection = db
      .prepare(
        "SELECT status,metadata FROM connections WHERE id=? AND owner_id=?",
      )
      .get("native-" + name, OWNER) as
      { status: string; metadata: string } | undefined;
    // An intentional disconnect is not an invitation to sign in again.
    if (
      connection?.status === "disconnected" &&
      !JSON.parse(connection.metadata).retiredDirectRuntime
    )
      continue;
    const saved = registered.some((r) => r.name === name)
      ? nativeSessions.registration(name)
      : undefined;
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
      await nativeSessions.enable(
        saved
          ? { ...saved, executable: probe.executable, version: probe.version }
          : {
              harness: name,
              executable: probe.executable,
              version: probe.version,
              project,
              billing:
                name === "opencode" || name === "pi" || name === "acp"
                  ? "existing"
                  : "subscription",
            },
      );
      enabled++;
    } catch {
      // Never print provider configuration, credentials or raw auth subprocess output.
      // Verification failure must not leave a stale account available for dispatch.
      db.prepare(
        "UPDATE connections SET status='needs_sign_in' WHERE id=? AND owner_id=? AND status<>'disconnected'",
      ).run("native-" + name, OWNER);
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
