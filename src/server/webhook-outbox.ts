import * as eventsQueries from "./sql/events.js";
import * as webhookSubscriptionsQueries from "./sql/webhook-subscriptions.js";
import * as approvalsQueries from "./sql/approvals.js";
import * as nativeDecisionsQueries from "./sql/native-decisions.js";
import * as webhookDeliveriesQueries from "./sql/webhook-deliveries.js";
import * as runsQueries from "./sql/runs.js";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { WebhookStop } from "../shared/webhooks.js";
import { plainPreview } from "../shared/text.js";
import { config } from "./config.js";

const reasons: Readonly<
  Record<
    string,
    | "finished"
    | "failed"
    | "cancelled"
    | "interrupted"
    | "paused"
    | "needs_input"
  >
> = {
  completed: "finished",
  failed: "failed",
  cancelled: "cancelled",
  interrupted: "interrupted",
  paused: "paused",
  awaiting_approval: "needs_input",
};
/** Called by the transition producer, before its transaction commits. Replaying
 * the same committed event for another projection cannot create another row. */
export function enqueueStoppedWebhooks(
  db: Database.Database,
  eventId: number | bigint,
) {
  if (!db.inTransaction)
    throw new Error("Webhook events require the transition transaction");
  const event = eventsQueries.webhookEvent(db, eventId);
  if (!event || !event.run_id || !reasons[event.type]) return;
  const subscriptions = webhookSubscriptionsQueries.stoppedSubscribers(
    db,
    event.owner_id,
  );
  if (!subscriptions.length) return;
  const run = runsQueries.webhookContext(db, event.run_id, event.owner_id);
  if (!run || run.state !== event.type)
    throw new Error("Webhook event does not describe the current transition");
  let needs: { kind: "approval" | "answer"; id: string } | undefined;
  if (event.type === "awaiting_approval") {
    const approval = approvalsQueries.pendingWebhook(
      db,
      run.id,
      event.owner_id,
    );
    if (approval) needs = { kind: "approval", id: approval.id };
    else {
      const decision = nativeDecisionsQueries.pendingWebhook(db, run.id);
      if (decision)
        needs = {
          kind: decision.kind === "approval" ? "approval" : "answer",
          id: decision.id,
        };
    }
  }
  const url = new URL("/", new URL(config.url).origin);
  if (run.conversation_id)
    url.searchParams.set("conversation", run.conversation_id);
  for (const subscription of subscriptions) {
    const payload = WebhookStop.parse({
      id: randomUUID(),
      event_id: event.id,
      kind: "run.stopped",
      version: 1,
      occurred_at: event.created_at,
      reason: reasons[event.type],
      ...(needs ? { needs } : {}),
      run_id: run.id,
      conversation_id: run.conversation_id,
      agent: run.agent_id
        ? { id: run.agent_id, name: run.agent_name || "" }
        : null,
      ...(run.project_id ? { project_id: run.project_id } : {}),
      ...(run.team_id ? { team_id: run.team_id } : {}),
      title: plainPreview(run.title || "", 240),
      result_preview: plainPreview(run.preview, 180),
      url: url.href,
    });
    webhookDeliveriesQueries.enqueueStopped(
      db,
      payload.id,
      subscription.id,
      event.id,
      JSON.stringify(payload),
      event.created_at,
    );
  }
}
