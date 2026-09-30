/** Public lifecycle metadata only; never subprocess errors or configuration. */
export type RuntimeSetupState =
  | "idle"
  | "preparing"
  | "starting"
  | "ready"
  | "fallback"
  | "failed"
  | "stopped";
export const runtimeSetupMessages: Record<RuntimeSetupState, string> = {
  idle: "Use installed runtimes on this computer.",
  preparing:
    "Setting up managed execution. First setup may take several minutes; you can continue using the workspace.",
  starting: "Starting the managed runner. Your workspace is available.",
  ready: "Managed runner startup completed.",
  fallback:
    "Managed execution could not start. Installed runtimes remain available through direct execution.",
  failed:
    "Managed execution cleanup failed. Restart the workspace before enabling runtimes.",
  stopped: "Managed execution stopped.",
};
