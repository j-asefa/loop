import { z } from "zod";
import { BuildIdentity } from "./build.js";

const Text = z.string(),
  Count = z.number();
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
// The HTTP fallback predates V3 socket frames. Keep its array and serialized
// payload unchanged; the event reader performs the existing normalization.
export const PublicHttpEvent = z.object({
  id: Count,
  owner_id: Text,
  run_id: Text.nullable(),
  type: Text,
  payload: Text,
  created_at: Count,
  // Sources predating subject routing omit these; absence grants no authority.
  subject_kind: Text.optional(),
  subject_id: Text.nullable().optional(),
});
export const PublicAuthOptions = z.object({
  mode: z.enum(["paired", "single-user", "multi-user"]),
  github: z.boolean(),
});
// The session read exposes only the display identity used by the shell.
// Better Auth still owns cookies, expiry and renewal; its session row is private.
export const PublicAuthSession = z
  .object({
    user: z.object({ id: Text, name: Text }),
    // Better Auth's account-session endpoint has no Loop deployment-mode field.
    mode: z.enum(["paired", "single-user", "multi-user"]).optional(),
  })
  .nullable();
export const AuthSessionQuery = z.object({
  disableCookieCache: z.coerce.boolean().optional(),
  disableRefresh: z.coerce.boolean().optional(),
});
export const AuthSignInEmailInput = z.object({
  email: Text,
  password: Text,
  name: Text.optional(),
});
export const AuthSignUpEmailInput = AuthSignInEmailInput.extend({ name: Text });
export const FederationImportInput = z.object({
  peerId: Text,
  label: Text.max(80),
  endpoint: Text,
  token: Text,
});
export const FederationReverseInput = FederationImportInput.pick({
  peerId: true,
  label: true,
}).extend({ tools: z.unknown() });
export const PublicFederationImport = z.object({
  id: Text,
  status: z.literal("connected"),
});
export const PublicReverseCalls = z.array(
  z.object({
    id: Text,
    runKey: Text,
    requestKey: Text,
    name: Text,
    args: Text,
  }),
);

export const DiagnosticInput = z
  .union([z.object({ key: z.unknown().optional() }), z.array(z.unknown())])
  .transform((value) => ({ key: "key" in value ? value.key : undefined }));
