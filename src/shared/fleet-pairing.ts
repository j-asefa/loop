import { z } from "zod";
import { FleetCapabilities, FleetOrigin, MachineIdentity } from "./fleet.js";
import { FleetSecret } from "./fleet-credentials.js";

const LinkBase = z.object({
  version: z.literal(1),
  ceremonyId: z.string().uuid(),
  origin: FleetOrigin,
  machine: MachineIdentity,
  scope: FleetCapabilities,
  enrollment: FleetSecret,
});
export const FleetPairLink = z.discriminatedUnion("kind", [
  LinkBase.extend({
    kind: z.literal("combined"),
    device: FleetSecret,
  }).strict(),
  LinkBase.extend({ kind: z.literal("enrollment") }).strict(),
]);
export type FleetPairLink = z.infer<typeof FleetPairLink>;
export const FleetEnrollmentLink = LinkBase.strict();
export type FleetEnrollmentLink = z.infer<typeof FleetEnrollmentLink>;

export function formatFleetPairLink(input: FleetPairLink) {
  const value = FleetPairLink.parse(input);
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const encoded = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const link = `${value.origin}/#fleet=${encoded}`;
  if (link.length > 4096) throw new Error("This pairing link is too large.");
  return link;
}

function linkUrl(input: string) {
  if (input.length > 4096) throw new Error("This pairing link is too large.");
  const url = new URL(input);
  if (url.username || url.password || url.pathname !== "/" || url.search)
    throw new Error("Use the complete pairing link printed by Loop.");
  return url;
}
function parseFleetLink(url: URL): FleetPairLink {
  FleetOrigin.parse(url.origin);
  const entries = [...new URLSearchParams(url.hash.slice(1))];
  if (
    entries.length !== 1 ||
    entries[0][0] !== "fleet" ||
    !/^[A-Za-z0-9_-]{1,3500}$/.test(entries[0][1])
  )
    throw new Error(
      "Use a fresh fleet enrollment link from the destination machine.",
    );
  const encoded = entries[0][1];
  let value: FleetPairLink;
  try {
    const ascii = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
    const json = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(ascii, (c) => c.charCodeAt(0)),
    );
    value = FleetPairLink.parse(JSON.parse(json));
  } catch {
    throw new Error(
      "This fleet pairing link is invalid or uses an unsupported version.",
    );
  }
  if (value.origin !== url.origin)
    throw new Error("The machine address does not match its pairing link.");
  return value;
}

/** Browser-only capability separation: this projection cannot carry the device
 * half to the controller. Never send the original link to a server or logger. */
export function fleetEnrollmentFromLink(input: string): FleetEnrollmentLink {
  const value = parseFleetLink(linkUrl(input));
  return FleetEnrollmentLink.parse({
    version: value.version,
    ceremonyId: value.ceremonyId,
    origin: value.origin,
    machine: value.machine,
    scope: value.scope,
    enrollment: value.enrollment,
  });
}

/** The OS-camera flow opens the destination itself. An enrollment-only link is
 * intentionally not a device pairing credential. Device links use a separate credential. */
export function fleetDeviceFromLink(
  input: string,
  expectedOrigin: string,
): { secret: string; ceremonyId?: string } {
  const url = linkUrl(input);
  if (url.origin !== expectedOrigin)
    throw new Error("Pair this device at the printed machine address.");
  const entries = [...new URLSearchParams(url.hash.slice(1))];
  if (entries.length === 1 && entries[0][0] === "pair")
    return { secret: FleetSecret.parse(entries[0][1]) };
  const value = parseFleetLink(url);
  if (value.kind !== "combined")
    throw new Error(
      "This link enrolls a machine. Run loop pair to pair this device.",
    );
  return { secret: value.device, ceremonyId: value.ceremonyId };
}
