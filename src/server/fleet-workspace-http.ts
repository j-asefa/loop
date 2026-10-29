import type { z } from "zod";
import {
  fleetWorkspaceApi,
  type FleetReadRequest,
} from "../shared/fleet-workspace-api.js";
import { FleetPeerHttpTransport } from "./fleet-peer-transport.js";
import { fleetPeerApi } from "../shared/fleet-peer-api.js";
import type { FleetEnrollmentProbe } from "../shared/fleet-enrollment.js";
import type { FleetIdentityTransport } from "./fleet-peer-identity.js";

export interface FleetWorkspaceTransport extends FleetIdentityTransport {
  catalog(
    origin: string,
    input: z.input<typeof fleetWorkspaceApi.catalog.body>,
    signal: AbortSignal,
  ): Promise<unknown>;
  read(
    origin: string,
    input: FleetReadRequest,
    signal: AbortSignal,
  ): Promise<unknown>;
}
export class FleetWorkspaceHttpTransport
  extends FleetPeerHttpTransport
  implements FleetWorkspaceTransport
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
  read(origin: string, input: FleetReadRequest, signal: AbortSignal) {
    return this.exchange(origin, fleetWorkspaceApi.read, input, signal);
  }
}
