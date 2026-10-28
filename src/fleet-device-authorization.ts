import type { IncomingMessage } from "node:http";

// Set only by the companion Host after device, Host, Origin and CSRF checks.
// Neither a network header nor the peer router can construct this property.
export const fleetDeviceAuthorization = Symbol("fleet-local-device");
export type FleetDeviceRequest = IncomingMessage & {
  [fleetDeviceAuthorization]?: {
    deviceId: string;
    active: boolean;
    current: () => boolean;
  };
};
