import { z } from "zod";
import { Capabilities } from "./capabilities.js";
import * as app from "./app-contract-schemas.js";
import { endpoint, base } from "./route-contract.js";
import { PublicRun, CardErrorSchema } from "./workspace-contract-schemas.js";

export const appRoutes = {
  capabilities: endpoint({
    ...base,
    operation: "capabilities",
    security: "public",
    method: "GET",
    path: "/capabilities",
    response: Capabilities,
  }),
  health: endpoint({
    ...base,
    operation: "health",
    security: "public",
    method: "GET",
    path: "/health",
    response: app.PublicHealth,
    additionalStatuses: [503],
  }),
  build: endpoint({
    ...base,
    operation: "build",
    method: "GET",
    path: "/build",
    response: app.PublicBuild,
  }),
  diagnostic: endpoint({
    ...base,
    operation: "diagnostic",
    method: "POST",
    path: "/diagnostic",
    body: app.DiagnosticInput,
    response: PublicRun,
  }),
  events: endpoint({
    ...base,
    operation: "events",
    access: { admits: ["read"] },
    method: "GET",
    path: "/events",
    query: z.object({ after: z.unknown().optional() }),
    response: z.array(app.PublicHttpEvent),
  }),
  tokenEvents: endpoint({
    ...base,
    operation: "tokenEvents",
    access: { admits: ["read"] },
    security: "integration-token",
    method: "GET",
    path: "/events/stream",
    query: z.strictObject({
      after: z.coerce
        .number<string>()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER)
        .optional(),
    }),
    status: 426,
    response: CardErrorSchema,
  }),
  authSession: endpoint({
    ...base,
    operation: "authSession",
    security: "optional-session",
    method: "GET",
    path: "/auth/get-session",
    response: app.PublicAuthSession,
  }),
} as const;
