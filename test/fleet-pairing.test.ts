import { expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { generateMachineKey } from "../src/server/fleet-crypto.js";
import {
  fleetDeviceFromLink,
  fleetEnrollmentFromLink,
  formatFleetPairLink,
  type FleetPairLink,
} from "../src/shared/fleet-pairing.js";

function fixture(): FleetPairLink & { kind: "combined" } {
  return {
    version: 1,
    ceremonyId: randomUUID(),
    origin: "https://destination.example",
    machine: generateMachineKey().identity,
    scope: ["read", "act", "events", "mail", "files"],
    kind: "combined",
    device: randomBytes(32).toString("base64url"),
    enrollment: randomBytes(32).toString("base64url"),
  };
}
it("projects only the enrollment capability when a controller scans or pastes a combined link", () => {
  const value = fixture(),
    link = formatFleetPairLink(value);
  const enrollment = fleetEnrollmentFromLink(link);
  expect(enrollment).toEqual({
    version: 1,
    ceremonyId: value.ceremonyId,
    origin: value.origin,
    machine: value.machine,
    scope: value.scope,
    enrollment: value.enrollment,
  });
  expect(JSON.stringify(enrollment)).not.toContain(value.device);
  expect("device" in enrollment).toBe(false);
  expect(fleetDeviceFromLink(link, value.origin)).toEqual({
    secret: value.device,
    ceremonyId: value.ceremonyId,
  });
  expect(JSON.stringify(fleetDeviceFromLink(link, value.origin))).not.toContain(
    value.enrollment,
  );
});
it("keeps enrollment-only and legacy device-only links separate", () => {
  const value = fixture();
  const { device, ...base } = value;
  const link = formatFleetPairLink({ ...base, kind: "enrollment" });
  expect(fleetEnrollmentFromLink(link).enrollment).toBe(value.enrollment);
  expect(() => fleetDeviceFromLink(link, value.origin)).toThrow(
    "enrolls a machine",
  );
  const legacy = `${value.origin}/#pair=${device}`;
  expect(fleetDeviceFromLink(legacy, value.origin)).toEqual({ secret: device });
  expect(() => fleetEnrollmentFromLink(legacy)).toThrow(
    "fresh fleet enrollment",
  );
  const local = `http://127.0.0.1:4321/#pair=${device}`;
  expect(fleetDeviceFromLink(local, "http://127.0.0.1:4321")).toEqual({
    secret: device,
  });
  expect(() => fleetEnrollmentFromLink(local)).toThrow();
});
it("rejects swapped origins, duplicate capabilities, extra fields and unsupported versions", () => {
  const value = fixture(),
    link = formatFleetPairLink(value);
  expect(() =>
    fleetEnrollmentFromLink(
      link.replace(value.origin, "https://substitute.example"),
    ),
  ).toThrow("does not match");
  expect(() => fleetDeviceFromLink(link, "https://substitute.example")).toThrow(
    "printed machine address",
  );
  for (const suffix of ["&pair=unused", "&fleet=unused", "&device=unused"])
    expect(() => fleetEnrollmentFromLink(link + suffix)).toThrow();
  const encoded = (object: unknown) =>
    `${value.origin}/#fleet=${Buffer.from(JSON.stringify(object)).toString("base64url")}`;
  expect(() =>
    fleetEnrollmentFromLink(encoded({ ...value, version: 2 })),
  ).toThrow("unsupported version");
  expect(() =>
    fleetEnrollmentFromLink(encoded({ ...value, owner: "nominated-owner" })),
  ).toThrow("invalid");
  expect(() =>
    fleetEnrollmentFromLink(link.replace("/#fleet", "/path#fleet")),
  ).toThrow();
  expect(() =>
    fleetEnrollmentFromLink(link.replace("/#fleet", "/?capture=1#fleet")),
  ).toThrow();
  expect(() => fleetEnrollmentFromLink("x".repeat(4097))).toThrow("too large");
});
