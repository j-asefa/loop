import type { Capabilities } from "../shared/capabilities";
import type { RouteContract } from "../shared/workspace-api";
import { fleetComposerReason, fleetOperationReason } from "./fleetCapabilities";

// The feed and composer ask why a source refuses an operation without knowing
// which extension constrains it. A source with no fleet catalog has no fleet
// restriction. A peer source is always checked, so a missing catalog keeps
// refusing.
const constrained = (source: string, capabilities?: Capabilities) =>
  !!capabilities?.fleet || source.startsWith("peer:");

export function composerBlockReason(
  source: string,
  capabilities: Capabilities | undefined,
  draft: string,
  selected: string,
): string | undefined {
  if (!constrained(source, capabilities)) return;
  return fleetComposerReason(source, capabilities, draft, selected);
}

export function operationBlockReason(
  source: string,
  capabilities: Capabilities | undefined,
  contract: RouteContract,
): string | undefined {
  if (!constrained(source, capabilities)) return;
  return fleetOperationReason(source, capabilities, contract);
}
