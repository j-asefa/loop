import type { z } from "zod";
import { fleetWorkspaceUploadApi } from "../shared/fleet-workspace-upload-api.js";
import { fleetWorkspaceApi } from "../shared/fleet-workspace-api.js";
import { fleetPeerApi } from "../shared/fleet-peer-api.js";
import type { FleetEnrollmentProbe } from "../shared/fleet-enrollment.js";
import type { FleetIdentityTransport } from "./fleet-peer-identity.js";
import { FleetPeerHttpTransport } from "./fleet-peer-transport.js";

type Input<K extends keyof typeof fleetWorkspaceUploadApi> = z.input<
  (typeof fleetWorkspaceUploadApi)[K]["body"]
>;
export interface FleetWorkspaceUploadTransport extends FleetIdentityTransport {
  catalog(
    origin: string,
    input: z.input<typeof fleetWorkspaceApi.catalog.body>,
    signal: AbortSignal,
  ): Promise<unknown>;
  prepare(
    origin: string,
    input: Input<"prepare">,
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
  commit(
    origin: string,
    input: Input<"commit">,
    signal: AbortSignal,
  ): Promise<unknown>;
  receipt(
    origin: string,
    input: Input<"receipt">,
    signal: AbortSignal,
  ): Promise<unknown>;
}
export class FleetWorkspaceUploadHttpTransport
  extends FleetPeerHttpTransport
  implements FleetWorkspaceUploadTransport
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
  prepare(origin: string, input: Input<"prepare">, signal: AbortSignal) {
    return this.exchange(
      origin,
      fleetWorkspaceUploadApi.prepare,
      input,
      signal,
    );
  }
  chunk(origin: string, input: Input<"chunk">, signal: AbortSignal) {
    return this.exchange(origin, fleetWorkspaceUploadApi.chunk, input, signal);
  }
  release(origin: string, input: Input<"close">, signal: AbortSignal) {
    return this.exchange(origin, fleetWorkspaceUploadApi.close, input, signal);
  }
  commit(origin: string, input: Input<"commit">, signal: AbortSignal) {
    return this.exchange(origin, fleetWorkspaceUploadApi.commit, input, signal);
  }
  receipt(origin: string, input: Input<"receipt">, signal: AbortSignal) {
    return this.exchange(
      origin,
      fleetWorkspaceUploadApi.receipt,
      input,
      signal,
    );
  }
}
