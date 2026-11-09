import { z } from "zod";

import { ManagedHarness } from "./harnesses.js";
export { ManagedHarness };
export const NativeProvider = z.object({
  id: z.string(),
  name: z.string(),
  configured: z.boolean().optional(),
  source: z
    .enum(["stored", "environment", "configuration", "runtime", "unknown"])
    .optional(),
  credentialType: z.enum(["api", "oauth"]).optional(),
  removable: z.boolean().optional(),
  methods: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      type: z.enum(["api", "oauth"]),
    }),
  ),
});
export const NativeProviderView = z.object({
  providers: z.array(NativeProvider),
  models: z.array(z.object({ id: z.string(), name: z.string() })),
  agents: z.array(z.object({ name: z.string(), model: z.string() })),
  billing: z.enum(["existing", "subscription"]),
  enabled: z.boolean(),
  updatedAt: z.number(),
  syncError: z.string().optional(),
});
export type NativeProviderView = z.infer<typeof NativeProviderView>;
export const ProviderTarget = z.object({
  name: ManagedHarness,
  projectId: z.string().min(1),
});
export const ProviderKey = ProviderTarget.extend({
  provider: z.string().min(1).max(200),
  method: z.string().min(1).max(100),
  // A browser key field accepts a literal credential, never Pi's !command syntax.
  secret: z
    .string()
    .trim()
    .min(1)
    .max(16000)
    .regex(/^[^!\r\n][^\r\n]*$/),
});
export const ProviderRemove = ProviderTarget.extend({
  provider: z.string().min(1).max(200),
});
export const ProviderRefresh = ProviderTarget.extend({
  useProviderBilling: z.boolean().optional(),
});
