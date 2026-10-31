import type { FleetMailCaller } from "../shared/fleet-mail-worker.js";
import type { FleetAgentQuery } from "../shared/fleet-mail-api.js";
import type {
  MailDiscoveryPage,
  MailDiscoverySource,
} from "../shared/fleet-mail-discovery.js";
import type { FleetMailDiscoveryPort } from "./fleet-mail-discovery.js";
import { assertMailDiscoveryCaller } from "./agent-mail.js";

export type FleetMailWorkerService = {
  observe?(changed: () => void): () => void;
  sources(): MailDiscoverySource[];
  read(
    source: string,
    query: FleetAgentQuery,
    caller: FleetMailCaller,
    current: () => void,
  ): Promise<MailDiscoveryPage>;
};
export function fleetMailWorkerService(
  owner: string,
  discovery: FleetMailDiscoveryPort,
): FleetMailWorkerService {
  return {
    sources: () => discovery.sources(),
    read(source, query, caller, current) {
      const authorize = () => {
        current();
        assertMailDiscoveryCaller(owner, caller);
      };
      authorize();
      return discovery.read(source, query, authorize, caller);
    },
  };
}
