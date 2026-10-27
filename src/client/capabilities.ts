import { readRoute } from "./workspace-api";
import { workspaceApi } from "../shared/workspace-api";
import { profileCapabilities, type Capabilities } from "../shared/capabilities";
import { executionSourceId, returnToLocalSource } from "./sourceRouting";
export let capabilities: Capabilities = profileCapabilities("server");
export async function loadCapabilities() {
  const source = executionSourceId();
  const controller = new AbortController();
  try {
    capabilities = await readRoute(
      workspaceApi.capabilities,
      {},
      source,
      controller.signal,
    );
  } catch (error) {
    const status = (error as { status?: number }).status;
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
    controller.abort();
  }
}
