import type { Adapter } from "../../adapters/types.js";
import { undiscoveredCapabilities } from "../../shared/agent-activities.js";

export function adapterCapabilities(adapter?: Adapter) {
  return (
    adapter?.activityCapabilities ||
    undiscoveredCapabilities("Native adapter has not reported activity support")
  );
}

export function adapterControlSnapshot(adapter?: Adapter) {
  return {
    commands: adapter?.commandCatalog || { commands: [], revision: 0 },
    capabilities: adapterCapabilities(adapter),
  };
}
