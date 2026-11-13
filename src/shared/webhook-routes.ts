import { WebhookSubscriptionId, requestId } from "./contract-ids.js";
import { z } from "zod";
import * as webhooks from "./webhooks.js";
import { endpoint, base } from "./route-contract.js";

export const webhookRoutes = {
  webhooks: endpoint({
    ...base,
    operation: "webhooks",
    method: "GET",
    path: "/webhooks",
    response: webhooks.WebhookList,
  }),
  webhookCreate: endpoint({
    ...base,
    operation: "webhookCreate",
    method: "POST",
    path: "/webhooks",
    body: webhooks.WebhookCreate,
    response: webhooks.WebhookCreated,
    status: 201,
  }),
  webhookUpdate: endpoint({
    ...base,
    operation: "webhookUpdate",
    method: "PATCH",
    path: "/webhooks/:id",
    params: z.object({ id: requestId(WebhookSubscriptionId) }),
    body: webhooks.WebhookUpdate,
    response: webhooks.WebhookSubscription,
  }),
  webhookTest: endpoint({
    ...base,
    operation: "webhookTest",
    method: "POST",
    path: "/webhooks/:id/test",
    params: z.object({ id: requestId(WebhookSubscriptionId) }),
    body: webhooks.WebhookRequest,
    response: z.object({
      subscription: webhooks.WebhookSubscription,
      delivery: webhooks.WebhookDelivery,
    }),
  }),
  webhookRetry: endpoint({
    ...base,
    operation: "webhookRetry",
    method: "POST",
    path: "/webhooks/:id/retry",
    params: z.object({ id: requestId(WebhookSubscriptionId) }),
    body: webhooks.WebhookRequest,
    response: webhooks.WebhookSubscription,
  }),
  webhookRevoke: endpoint({
    ...base,
    operation: "webhookRevoke",
    method: "POST",
    path: "/webhooks/:id/revoke",
    params: z.object({ id: requestId(WebhookSubscriptionId) }),
    body: webhooks.WebhookRequest,
    response: webhooks.WebhookSubscription,
  }),
  webhookDeliveries: endpoint({
    ...base,
    operation: "webhookDeliveries",
    method: "GET",
    path: "/webhooks/:id/deliveries",
    params: z.object({ id: requestId(WebhookSubscriptionId) }),
    response: z.array(webhooks.WebhookDelivery),
  }),
} as const;
