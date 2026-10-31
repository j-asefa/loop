import { z } from "zod";
import { FleetAgentQuery } from "./fleet-mail-api.js";
import {
  MailDiscoveryPage,
  MailDiscoverySource,
  MailSourceId,
} from "./fleet-mail-discovery.js";

/** Only the inherited execution IPC carries these messages. No key, peer
 * credential, origin, browser session or native context crosses this boundary. */
export const FleetMailCaller = z.strictObject({
  runId: z.string().uuid(),
  agentId: z.string().min(1).max(200),
  conversationId: z.string().min(1).max(200).nullable(),
  connectionId: z.string().min(1).max(200),
  nativeGeneration: z.string().uuid().nullable(),
});
export type FleetMailCaller = z.infer<typeof FleetMailCaller>;
const identity = {
  requestId: z.string().uuid(),
  generation: z.string().uuid(),
  binding: z.string().uuid(),
};
export const FleetMailWorkerRequest = z.strictObject({
  ...identity,
  sourceId: MailSourceId.refine(Boolean),
  query: FleetAgentQuery,
  caller: FleetMailCaller,
});
export type FleetMailWorkerRequest = z.infer<typeof FleetMailWorkerRequest>;
export const FleetMailWorkerResponse = z.discriminatedUnion("ok", [
  z.strictObject({ ...identity, ok: z.literal(true), page: MailDiscoveryPage }),
  z.strictObject({
    ...identity,
    ok: z.literal(false),
    error: z.strictObject({
      status: z.number().int().min(400).max(599),
      message: z.string().max(300),
    }),
  }),
]);
export type FleetMailWorkerResponse = z.infer<typeof FleetMailWorkerResponse>;
export const FleetMailWorkerState = z
  .strictObject({
    requestId: z.string().uuid(),
    generation: z.string().uuid(),
    // A replacement service invalidates outstanding reads without changing the
    // execution owner. A directory refresh on that service retains the binding.
    binding: z.string().uuid().nullable(),
    sources: z.array(MailDiscoverySource).max(128),
  })
  .refine((value) => value.binding !== null || !value.sources.length);
export type FleetMailWorkerState = z.infer<typeof FleetMailWorkerState>;
