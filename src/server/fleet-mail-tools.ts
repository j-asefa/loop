import { Problem } from "../shared/problem.js";
import type { FleetMailDiscoveryPort } from "./fleet-mail-discovery.js";

// Installed only by the owning execution lifecycle after its fleet transport
// is configured. A tool cannot activate a remote route or choose a local owner.
const enabled = new Map<
  string,
  { token: object; discovery?: FleetMailDiscoveryPort }
>();
export function installFleetMailTools(
  owner: string,
  discovery?: FleetMailDiscoveryPort,
) {
  const token = {};
  enabled.set(owner, { token, discovery });
  return () => {
    if (enabled.get(owner)?.token === token) enabled.delete(owner);
  };
}
export const fleetMailDiscovery = (owner: string) =>
  enabled.get(owner)?.discovery;
export function assertFleetMailTools(owner: string) {
  if (!enabled.has(owner))
    throw new Problem(
      503,
      "Remote agent mail is unavailable in this workspace.",
    );
}
