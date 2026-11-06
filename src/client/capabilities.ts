import { boundSourceCapabilities } from "./fleetCapabilities";
import { readRoute } from "./workspace-api";
import { workspaceApi } from "../shared/workspace-api";
import {
  workspaceCapabilities,
  type Capabilities,
} from "../shared/capabilities";
import { executionSourceId, returnToLocalSource } from "./sourceRouting";
// Device administration remains unavailable until gateway capabilities load.
export let capabilities: Capabilities = {
  ...workspaceCapabilities(),
  pairedDevices: false,
};
export async function loadCapabilities() {
  const source = executionSourceId();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let gateway: Capabilities | undefined;
  try {
    if (source)
      gateway = await readRoute(
        workspaceApi.capabilities,
        {},
        "",
        controller.signal,
      );
    capabilities = await readRoute(
      workspaceApi.capabilities,
      {},
      source,
      controller.signal,
      undefined,
      source.startsWith("peer:") ? "manual" : "automatic",
    );
    if (gateway)
      capabilities = { ...capabilities, pairedDevices: gateway.pairedDevices };
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (source.startsWith("peer:")) {
      if (!gateway) throw error;
      capabilities = {
        ...boundSourceCapabilities(source)!,
        pairedDevices: gateway.pairedDevices,
      };
      return;
    }
    if (status === 401 && source) {
      try {
        capabilities = await readRoute(
          workspaceApi.capabilities,
          {},
          "",
          controller.signal,
        );
      } catch (localError) {
        if (!(localError as { status?: number }).status) throw localError;
      }
    }
    if (status && source) {
      returnToLocalSource();
      return;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}
