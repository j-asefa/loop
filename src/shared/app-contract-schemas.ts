import { z } from "zod";
import { BuildIdentity } from "./build.js";

const Text = z.string(),
  Count = z.number();
export const PublicPairedDevice = z.object({
  id: Text,
  name: Text,
  expires: Count,
});
// The host has always stringified the supplied ID before attempting revocation.
export const PairedDeviceRevokeInput = z.object({ id: z.coerce.string() });
export const PublicHealth = z.object({
  ok: z.boolean(),
  database: z.literal(true),
  worker: z.enum(["ready", "simulated", "unavailable"]),
});
export const PublicBuild = z.object({
  serving: BuildIdentity,
  processes: z.array(
    z.object({
      instance: Text,
      role: z.enum(["api", "worker"]),
      startedAt: Count,
      observedAt: Count,
      build: BuildIdentity,
    }),
  ),
  // Builds before 231973a9 report serving/process identities without this observer.
  eventLoop: z
    .object({
      observing: z.boolean(),
      windowMs: Count,
      samples: Count,
      meanMs: Count,
      p95Ms: Count,
      p99Ms: Count,
      maxMs: Count,
    })
    .optional(),
});
// HTTP polling returns stored events with serialized payloads; the browser
// event reader normalizes them into the same updates as socket frames.
export const PublicHttpEvent = z.object({
  id: Count,
  owner_id: Text,
  run_id: Text.nullable(),
  type: Text,
  payload: Text,
  created_at: Count,
  subject_kind: Text,
  subject_id: Text.nullable(),
});
// The session read exposes only the display identity used by the shell.
export const PublicAuthSession = z
  .object({
    user: z.object({ id: Text, name: Text }),
    mode: z.literal("paired"),
  })
  .nullable();

export const DiagnosticInput = z
  .union([z.object({ key: z.unknown().optional() }), z.array(z.unknown())])
  .transform((value) => ({ key: "key" in value ? value.key : undefined }));
