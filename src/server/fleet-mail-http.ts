import type { z } from "zod";
import { fleetMailApi } from "../shared/fleet-mail-api.js";
import { fleetPeerApi } from "../shared/fleet-peer-api.js";
import type { FleetEnrollmentProbe } from "../shared/fleet-enrollment.js";
import type { FleetIdentityTransport } from "./fleet-peer-identity.js";
import { FleetPeerHttpTransport } from "./fleet-peer-transport.js";

export interface FleetMailTransport extends FleetIdentityTransport {
  file?(
    origin: string,
    input: z.input<typeof fleetMailApi.file.body>,
    signal: AbortSignal,
  ): Promise<unknown>;
  prepare(
    origin: string,
    input: z.input<typeof fleetMailApi.prepare.body>,
    signal: AbortSignal,
  ): Promise<unknown>;
  directory(
    origin: string,
    input: z.input<typeof fleetMailApi.directory.body>,
    signal: AbortSignal,
  ): Promise<unknown>;
  accept(
    origin: string,
    input: z.input<typeof fleetMailApi.accept.body>,
    signal: AbortSignal,
    beforeDispatch: () => void,
  ): Promise<unknown>;
  receipt(
    origin: string,
    input: z.input<typeof fleetMailApi.receipt.body>,
    signal: AbortSignal,
  ): Promise<unknown>;
}
/** Shares the companion's capacity budget, DNS guard, timeout and 429/5xx
 * cooldown. No browser cookie, agent URL or redirect enters this transport. */
export class FleetMailHttpTransport
  extends FleetPeerHttpTransport
  implements FleetMailTransport
{
  file(
    origin: string,
    input: z.input<typeof fleetMailApi.file.body>,
    signal: AbortSignal,
  ) {
    return this.exchange(origin, fleetMailApi.file, input, signal);
  }
  probe(origin: string, input: FleetEnrollmentProbe, signal: AbortSignal) {
    return this.exchange(origin, fleetPeerApi.enrollmentProbe, input, signal);
  }
  directory(
    origin: string,
    input: z.input<typeof fleetMailApi.directory.body>,
    signal: AbortSignal,
  ) {
    return this.exchange(origin, fleetMailApi.directory, input, signal);
  }
  prepare(
    origin: string,
    input: z.input<typeof fleetMailApi.prepare.body>,
    signal: AbortSignal,
  ) {
    return this.exchange(origin, fleetMailApi.prepare, input, signal);
  }
  accept(
    origin: string,
    input: z.input<typeof fleetMailApi.accept.body>,
    signal: AbortSignal,
    beforeDispatch: () => void,
  ) {
    return this.exchange(
      origin,
      fleetMailApi.accept,
      input,
      signal,
      beforeDispatch,
    );
  }
  receipt(
    origin: string,
    input: z.input<typeof fleetMailApi.receipt.body>,
    signal: AbortSignal,
  ) {
    return this.exchange(origin, fleetMailApi.receipt, input, signal);
  }
}
