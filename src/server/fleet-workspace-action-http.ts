import type { z } from "zod";
import { fleetWorkspaceActionApi } from "../shared/fleet-workspace-action-api.js";
import { FleetPeerHttpTransport } from "./fleet-peer-transport.js";

export interface FleetWorkspaceActionTransport {
  action(
    origin: string,
    input: z.input<typeof fleetWorkspaceActionApi.action.body>,
    signal: AbortSignal,
  ): Promise<unknown>;
  receipt(
    origin: string,
    input: z.input<typeof fleetWorkspaceActionApi.receipt.body>,
    signal: AbortSignal,
  ): Promise<unknown>;
}
export class FleetWorkspaceActionHttpTransport
  extends FleetPeerHttpTransport
  implements FleetWorkspaceActionTransport
{
  action(
    origin: string,
    input: z.input<typeof fleetWorkspaceActionApi.action.body>,
    signal: AbortSignal,
  ) {
    return this.exchange(origin, fleetWorkspaceActionApi.action, input, signal);
  }
  receipt(
    origin: string,
    input: z.input<typeof fleetWorkspaceActionApi.receipt.body>,
    signal: AbortSignal,
  ) {
    return this.exchange(
      origin,
      fleetWorkspaceActionApi.receipt,
      input,
      signal,
    );
  }
}
