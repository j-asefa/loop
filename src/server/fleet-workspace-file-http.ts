import type { z } from "zod";
import { fleetWorkspaceFileApi } from "../shared/fleet-workspace-file-api.js";
import { fleetWorkspaceApi } from "../shared/fleet-workspace-api.js";
import { fleetPeerApi } from "../shared/fleet-peer-api.js";
import type { FleetEnrollmentProbe } from "../shared/fleet-enrollment.js";
import type { FleetIdentityTransport } from "./fleet-peer-identity.js";
import { FleetPeerHttpTransport } from "./fleet-peer-transport.js";

type Input<K extends keyof typeof fleetWorkspaceFileApi> = z.input<
  (typeof fleetWorkspaceFileApi)[K]["body"]
>;
export interface FleetWorkspaceFileTransport extends FleetIdentityTransport {
  catalog(
    origin: string,
    input: z.input<typeof fleetWorkspaceApi.catalog.body>,
    signal: AbortSignal,
  ): Promise<unknown>;
  open(
    origin: string,
    input: Input<"open">,
    signal: AbortSignal,
  ): Promise<unknown>;
  chunk(
    origin: string,
    input: Input<"chunk">,
    signal: AbortSignal,
  ): Promise<unknown>;
  release(
    origin: string,
    input: Input<"close">,
    signal: AbortSignal,
  ): Promise<unknown>;
}
export class FleetWorkspaceFileHttpTransport
  extends FleetPeerHttpTransport
  implements FleetWorkspaceFileTransport
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
  open(origin: string, input: Input<"open">, signal: AbortSignal) {
    return this.exchange(origin, fleetWorkspaceFileApi.open, input, signal);
  }
  chunk(origin: string, input: Input<"chunk">, signal: AbortSignal) {
    return this.exchange(origin, fleetWorkspaceFileApi.chunk, input, signal);
  }
  release(origin: string, input: Input<"close">, signal: AbortSignal) {
    return this.exchange(origin, fleetWorkspaceFileApi.close, input, signal);
  }
}
