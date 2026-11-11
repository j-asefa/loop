import { z } from "zod";
import * as teams from "./team-contract-schemas.js";
import { NoBody, Ok, endpoint, base } from "./route-contract.js";

export const notificationRoutes = {
  notifications: endpoint({
    ...base,
    operation: "notifications",
    method: "GET",
    path: "/notifications",
    response: teams.PublicNotifications,
  }),
  notificationSubscribe: endpoint({
    ...base,
    operation: "notificationSubscribe",
    method: "POST",
    path: "/notifications/subscriptions",
    body: teams.NotificationSubscriptionInput,
    response: Ok,
    status: 201,
  }),
  notificationUnsubscribe: endpoint({
    ...base,
    operation: "notificationUnsubscribe",
    method: "DELETE",
    path: "/notifications/subscriptions",
    body: z.object({ endpoint: teams.PushEndpoint }),
    response: Ok,
  }),
  viewportDiagnostics: endpoint({
    ...base,
    operation: "viewportDiagnostics",
    method: "POST",
    path: "/ui/viewport-diagnostics",
    body: teams.ViewportInput,
    response: NoBody,
    status: 204,
  }),
} as const;
