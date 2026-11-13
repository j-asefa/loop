import { EventId, WebhookDecisionId } from "./contract-ids.js";
import {
  WebhookSubscriptionId,
  WebhookDeliveryId,
  WebhookRequestId,
  requestId,
  RunId,
  ConversationId,
  AgentId,
  ProjectId,
  TeamId,
} from "./contract-ids.js";
import { z } from "zod";

const Time = z.number().int().nonnegative();
const WebhookKind = z.literal("run.stopped");
const WebhookKinds = z.array(WebhookKind).max(1);
const WebhookState = z.enum([
  "pending_activation",
  "active",
  "failed",
  "revoked",
]);
export const WebhookStop = z
  .object({
    id: WebhookDeliveryId.uuid(),
    event_id: EventId.int().positive(),
    kind: WebhookKind,
    version: z.literal(1),
    occurred_at: Time,
    reason: z.enum([
      "finished",
      "failed",
      "cancelled",
      "interrupted",
      "paused",
      "needs_input",
    ]),
    needs: z
      .object({
        kind: z.enum(["approval", "answer"]),
        id: WebhookDecisionId,
      })
      .strict()
      .optional(),
    run_id: RunId.min(1).max(300),
    conversation_id: ConversationId.min(1).max(300).nullable(),
    agent: z
      .object({ id: AgentId.min(1).max(300), name: z.string() })
      .strict()
      .nullable(),
    project_id: ProjectId.min(1).max(300).optional(),
    team_id: TeamId.min(1).max(300).optional(),
    title: z.string().max(240),
    result_preview: z.string().max(180),
    url: z.string().url(),
  })
  .strict()
  .refine(
    (value) => value.needs === undefined || value.reason === "needs_input",
    {
      message: "Only needs_input carries a decision",
    },
  );
export const WebhookPing = z
  .object({
    id: WebhookDeliveryId.uuid(),
    type: z.literal("ping"),
    sent_at: Time,
  })
  .strict();
const WebhookOutcome = z.enum([
  "unattempted",
  "sending",
  "accepted",
  "rejected",
  "uncertain",
  "blocked",
  "cancelled",
]);
export const WebhookDelivery = z.object({
  id: WebhookDeliveryId.min(1).max(300),
  event_id: EventId.int().nullable(),
  kind: z.enum(["run.stopped", "control"]),
  purpose: z.enum(["activation", "test"]).nullable(),
  attempts: z.number().int().nonnegative(),
  available_at: Time,
  delivered_at: Time.nullable(),
  last_status: z.number().int().nullable(),
  last_error: z.string().nullable(),
  outcome: WebhookOutcome,
  exhausted: z.boolean(),
  in_flight: z.boolean(),
  created_at: Time,
});
export const WebhookSubscription = z.object({
  id: WebhookSubscriptionId.min(1).max(300),
  url: z.string().url(),
  local: z.boolean(),
  kinds: WebhookKinds,
  state: WebhookState,
  created_at: Time,
  activated_at: Time.nullable(),
  revoked_at: Time.nullable(),
  failed_at: Time.nullable(),
  last_delivered_at: Time.nullable(),
  last_status: z.number().int().nullable(),
  last_error: z.string().nullable(),
  activation: WebhookDelivery.nullable(),
  last_attempts: z.number().int().nonnegative(),
});
const WebhookPolicy = z.object({
  installation: z.literal("companion"),
  local_receivers: z.boolean(),
});
export const WebhookList = z.object({
  policy: WebhookPolicy,
  subscriptions: z.array(WebhookSubscription),
});
export const WebhookRequest = z
  .object({ request_id: requestId(WebhookRequestId).uuid() })
  .strict();
export const WebhookCreate = WebhookRequest.extend({
  url: z.string().trim().min(1).max(2048),
  secret: z.string().regex(/^loop_hook_[A-Za-z0-9_-]{43}$/),
  kinds: WebhookKinds,
}).strict();
export const WebhookUpdate = WebhookRequest.extend({
  kinds: WebhookKinds,
}).strict();
export const WebhookCreated = z.object({
  subscription: WebhookSubscription,
  secret: WebhookCreate.shape.secret,
});
export type WebhookSubscription = z.infer<typeof WebhookSubscription>;
export type WebhookDelivery = z.infer<typeof WebhookDelivery>;

/** Keep this receipt in memory until creation is acknowledged; retries reuse it. */
export function webhookRequest(
  url: string,
  kinds: z.infer<typeof WebhookKinds>,
) {
  const secret =
    "loop_hook_" +
    btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
  return { request_id: crypto.randomUUID(), url: url.trim(), secret, kinds };
}
