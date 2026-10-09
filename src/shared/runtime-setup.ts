/** Public lifecycle metadata only; never subprocess errors or configuration. */
export type RuntimeSetupState =
  | "idle"
  | "preparing"
  | "starting"
  | "ready"
  | "failed"
  | "stopped";
export const runtimeSetupMessages: Record<RuntimeSetupState, string> = {
  idle: "Start Loop to connect installed harnesses through HAPI.",
  preparing:
    "Setting up managed execution. First setup may take several minutes; you can continue using the workspace.",
  starting: "Starting the managed runner. Your workspace is available.",
  ready: "Managed runner startup completed.",
  failed:
    "HAPI setup failed. Harness execution is unavailable. Check loop logs and restart Loop to retry.",
  stopped: "Managed execution stopped.",
};
