/** Public lifecycle metadata only; never subprocess errors or configuration. */
export type RuntimeSetupState =
  "idle" | "preparing" | "starting" | "ready" | "failed" | "stopped";
export const runtimeSetupMessages: Record<RuntimeSetupState, string> = {
  idle: "Choose an installed harness and reuse its native sign-in.",
  preparing:
    "Checking installed harnesses and existing accounts. Your workspace is available.",
  starting: "Starting native harnesses. Your workspace is available.",
  ready:
    "Native harness discovery completed. Each account is verified before use.",
  failed:
    "Check installation and sign-in for the affected harness. Other harnesses remain available.",
  stopped: "Native execution stopped.",
};
