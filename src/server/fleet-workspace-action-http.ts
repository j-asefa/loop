import type { z } from "zod";
import { fleetWorkspaceActionApi } from "../shared/fleet-workspace-action-api.js";
import { FleetPeerHttpTransport } from "./fleet-peer-transport.js";
import { fleetWorkspaceApi } from "../shared/fleet-workspace-api.js";
import { fleetPeerApi } from "../shared/fleet-peer-api.js";
import type { FleetEnrollmentProbe } from "../shared/fleet-enrollment.js";
import type { FleetIdentityTransport } from "./fleet-peer-identity.js";

export interface FleetWorkspaceActionTransport extends FleetIdentityTransport {
  catalog(
    origin: string,
    input: z.input<typeof fleetWorkspaceApi.catalog.body>,
    signal: AbortSignal,
  ): Promise<unknown>;
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
  probe(origin: string, input: FleetEnrollmentProbe, signal: AbortSignal) {
    return this.exchange(origin, fleetPeerApi.enrollmentProbe, input, signal);
  }
  catalog(
    origin: string,
    input: z.input<typeof fleetWorkspaceApi.catalog.body>,
    signal: AbortSignal,
  ) {
    return this.exchange(origin, fleetWorkspaceApi.catalog, input, signal);
  }
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
