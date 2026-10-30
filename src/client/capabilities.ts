import { boundSourceCapabilities } from "./fleetCapabilities";
import { readRoute } from "./workspace-api";
import { workspaceApi } from "../shared/workspace-api";
import { profileCapabilities, type Capabilities } from "../shared/capabilities";
import { executionSourceId, returnToLocalSource } from "./sourceRouting";
export let capabilities: Capabilities = profileCapabilities("server");
export let eventMultiplexing = false;
export async function loadCapabilities() {
  eventMultiplexing = false;
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
    eventMultiplexing = !!(gateway ?? capabilities).eventMultiplex;
    if (gateway)
      capabilities = { ...capabilities, pairedDevices: gateway.pairedDevices };
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (source.startsWith("peer:")) {
      if (!gateway) throw error;
      eventMultiplexing = !!gateway.eventMultiplex;
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
        eventMultiplexing = !!capabilities.eventMultiplex;
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
