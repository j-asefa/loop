import { harnesses, type Harness } from "../../shared/harnesses.js";
import { classes } from "./adapters.js";
import { NativeRpcError, NativeTransportError } from "../../native.js";
import { NativeSetupError } from "../../adapters/setup-error.js";
import { Problem } from "../../shared/problem.js";
import { NativeMemoryError } from "../../native-memory.js";

/** Use only before prompt dispatch. Never use provider text to compose this
 * public message: it can contain credentials, paths or conversation content. */
export function nativeStartupFailure(
  harness: Harness,
  error: unknown,
  resuming = false,
): Problem {
  const label = harnesses[harness].label;
  const steps = classes[harness].startupSteps;
  if (error instanceof Problem) return error;
  if (error instanceof NativeMemoryError)
    return new Problem(503, `${error.message} No prompt was sent.`, {
      phase: "native startup",
      code: error.code,
      promptSent: false,
      ...(Number.isSafeInteger(error.limitBytes) && error.limitBytes! > 0
        ? {
            memoryLimitBytes: error.limitBytes,
            sharedMemoryLimit: error.shared,
          }
        : {}),
    });
  if (error instanceof NativeSetupError)
    return new Problem(422, error.message, {
      phase: "native startup",
      code: error.code,
      promptSent: false,
    });
  const diagnostic: Record<string, unknown> = {
    phase: "native startup",
    code: "native_startup_failed",
    promptSent: false,
  };
  const action = resuming ? "reconnect to this conversation" : "start";
  let reason = `${label} could not ${action}. Loop did not record a more specific startup cause.`;
  let guidance = `Check ${label} in Provider connections, then retry this run.`;
  if (error instanceof NativeTransportError) {
    diagnostic.code = error.code;
    if (error.code === "native_request_timeout") {
      const method = error.details.method;
      if (method && Object.hasOwn(steps, method)) diagnostic.method = method;
      diagnostic.timeoutMs = error.details.timeoutMs;
      const step =
        method && Object.hasOwn(steps, method)
          ? steps[method]
          : "completing startup";
      reason = `${label} did not respond within ${(error.details.timeoutMs ?? 30000) / 1000} seconds while ${step}.`;
      guidance = `Retry when the execution host is less busy. If it happens again, check ${label} in Provider connections.`;
    } else if (error.code === "native_process_exit") {
      const { signal, exitCode } = error.details;
      diagnostic.signal = signal;
      diagnostic.exitCode = exitCode;
      reason = `${label} exited during startup${signal ? ` (${signal})` : typeof exitCode === "number" ? ` (exit code ${exitCode})` : ""}.`;
      if (signal === "SIGKILL")
        guidance =
          "Check the execution host's resource limits and other processes that could stop the agent, then retry.";
    } else if (error.code === "native_connection_closed") {
      reason = `${label}'s connection closed before startup finished.`;
    } else if (error.details.systemCode === "ENOENT") {
      diagnostic.systemCode = "ENOENT";
      reason = `${label}'s executable or launch directory could not be found on the execution host.`;
      guidance =
        "Restore the executable and project directory, refresh the provider connection, then retry.";
    } else if (error.details.systemCode === "EACCES") {
      diagnostic.systemCode = "EACCES";
      reason = `The execution host denied permission to start ${label}.`;
      guidance =
        "Check the executable's permissions, refresh the provider connection, then retry.";
    }
  } else if (error instanceof NativeRpcError) {
    diagnostic.code = "native_startup_rejected";
    if (typeof error.code === "number") diagnostic.rpcCode = error.code;
    if (error.method && Object.hasOwn(steps, error.method))
      diagnostic.method = error.method;
    reason = `${label} rejected the request to ${action}${typeof error.code === "number" ? ` (code ${error.code})` : ""}.`;
  }
  return new Problem(
    503,
    `${reason} No prompt was sent. ${guidance}`,
    diagnostic,
  );
}
