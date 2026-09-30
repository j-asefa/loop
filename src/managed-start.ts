import { setRuntimeSetupState } from "./runtime-setup.js";

/** Run after the workspace gateway is listening, keeping setup failures local. */
export async function prepareManagedRuntime<T>(
  runtime: {
    prepare(): Promise<void>;
    start(): Promise<T>;
    close(): Promise<void>;
  },
  stopping: () => boolean,
  notice: (message: string) => void = console.log,
): Promise<T | undefined> {
  let stage = "preparation";
  try {
    if (stopping()) {
      setRuntimeSetupState("stopped");
      return;
    }
    setRuntimeSetupState("preparing");
    notice(
      "Preparing managed execution; first setup may take several minutes. See loop logs --follow.",
    );
    await runtime.prepare();
    if (stopping()) {
      setRuntimeSetupState("stopped");
      return;
    }
    stage = "runner startup";
    setRuntimeSetupState("starting");
    const result = await runtime.start();
    if (result == null) {
      throw new Error("Managed runner returned no account");
    }
    setRuntimeSetupState(stopping() ? "stopped" : "ready");
    return result;
  } catch {
    // Raw subprocess failures can contain configuration or sign-in output.
    // Cleanup failure must not be hidden: fallback is safe only after cleanup.
    setRuntimeSetupState("failed");
    await runtime.close();
    setRuntimeSetupState(stopping() ? "stopped" : "fallback");
    if (!stopping())
      notice(
        `Managed execution ${stage} failed. Installed runtimes remain available through direct execution.`,
      );
    return undefined;
  }
}
