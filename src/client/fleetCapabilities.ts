import type { Capabilities } from "../shared/capabilities";
import { profileCapabilities } from "../shared/capabilities";
import {
  fleetReadRoutes,
  isFleetReadContract,
} from "../shared/fleet-workspace-api";
import { fleetActionRoutes } from "../shared/fleet-workspace-action-api";
import { fleetFileRoutes } from "../shared/fleet-workspace-file-api";
import { workspaceApi, type RouteContract } from "../shared/workspace-api";

export function fleetComposerReason(
  source: string,
  capabilities: Capabilities | undefined,
  draft: string,
  selected: string,
): string | undefined {
  // The composer opens creation before either preview branch for @new.
  const createsAgent = /^@new\b/i.test(draft.trim());
  return [
    workspaceApi.submit,
    ...(!createsAgent && selected === "__route__"
      ? [workspaceApi.routingPreview]
      : []),
    ...(!createsAgent && draft.trim().startsWith("@")
      ? [workspaceApi.sharePreview]
      : []),
  ]
    .map((contract) => fleetOperationReason(source, capabilities, contract))
    .find(Boolean);
}

/** A source never inherits the gateway's operation permissions. */
export function boundSourceCapabilities(source: string, value?: Capabilities) {
  if (!source.startsWith("peer:")) return value;
  if (value?.fleet?.machineId === source.slice(5)) return value;
  return {
    ...profileCapabilities("companion"),
    pairedDevices: false,
    runtimeHosts: false,
    cardTokens: false,
    continuationStart: false,
    fleet: {
      version: 1 as const,
      machineId: source.slice(5),
      reads: [],
      actions: [],
      files: false,
      events: false,
    },
  };
}

export function fleetOperationReason(
  source: string,
  capabilities: Capabilities | undefined,
  contract: RouteContract,
): string | undefined {
  if (!source.startsWith("peer:")) return;
  if (capabilities?.fleet?.machineId !== source.slice(5))
    return "This machine's controls are unavailable. Retry its connection or open its own workspace.";
  const catalog = capabilities.fleet;
  if (
    contract.method === "GET" &&
    contract.kind === "stream" &&
    (Object.values(fleetFileRoutes).some(
      (value) => value.path === contract.path,
    ) ||
      contract.path === "/artifacts/:id/download")
  )
    return catalog.files
      ? undefined
      : "This machine's files are unavailable through the fleet. Update or re-pair it with files access, or open its own workspace.";
  const read = isFleetReadContract(contract);
  const collection = read ? fleetReadRoutes : fleetActionRoutes;
  const name = Object.entries(collection).find(
    ([, item]) =>
      item.method === contract.method && item.path === contract.path,
  )?.[0];
  if (!name || !(read ? catalog.reads : catalog.actions).includes(name))
    return "This machine does not allow this operation through the fleet. Update or re-pair it with the needed access, or open its own workspace.";
}
