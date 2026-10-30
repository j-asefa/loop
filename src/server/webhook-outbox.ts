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
  const event = db
    .prepare("SELECT id,owner_id,run_id,type,created_at FROM events WHERE id=?")
    .get(eventId) as
    | {
        id: number;
        owner_id: string;
        run_id: string | null;
        type: string;
        created_at: number;
      }
    | undefined;
  if (!event || !event.run_id || !reasons[event.type]) return;
  const subscriptions = db
    .prepare(
      `SELECT id FROM webhook_subscriptions
    WHERE owner_id=? AND state IN ('active','failed') AND EXISTS
    (SELECT 1 FROM json_each(kinds) WHERE value='run.stopped')`,
    )
    .all(event.owner_id) as { id: string }[];
  if (!subscriptions.length) return;
  const run = db
    .prepare(
      `SELECT r.id,r.state,c.id conversation_id,c.title,c.project_id,c.team_id,
    a.id agent_id,a.name agent_name,COALESCE((SELECT substr(content,1,4000) FROM artifacts
    WHERE run_id=r.id AND owner_id=r.owner_id AND kind IN ('markdown','text','message')
    ORDER BY created_at DESC,id DESC LIMIT 1),substr(r.result,1,4000),'') preview
    FROM runs r LEFT JOIN conversations c ON c.id=r.conversation_id AND c.owner_id=r.owner_id
    LEFT JOIN agents a ON a.id=r.agent_id AND a.owner_id=r.owner_id
    WHERE r.id=? AND r.owner_id=?`,
    )
    .get(event.run_id, event.owner_id) as
    | {
        id: string;
        state: string;
        conversation_id: string | null;
        title: string | null;
        project_id: string | null;
        team_id: string | null;
        agent_id: string | null;
        agent_name: string | null;
        preview: string;
      }
    | undefined;
  if (!run || run.state !== event.type)
    throw new Error("Webhook event does not describe the current transition");
  let needs: { kind: "approval" | "answer"; id: string } | undefined;
  if (event.type === "awaiting_approval") {
    const approval = db
      .prepare(
        "SELECT id FROM approvals WHERE run_id=? AND owner_id=? AND state='pending' ORDER BY created_at,id LIMIT 1",
      )
      .get(run.id, event.owner_id) as { id: string } | undefined;
    if (approval) needs = { kind: "approval", id: approval.id };
    else {
      const decision = db
        .prepare(
          "SELECT id,json_extract(request,'$.kind') kind FROM native_decisions WHERE run_id=? AND state='pending' ORDER BY created_at,id LIMIT 1",
        )
        .get(run.id) as { id: string; kind: string | null } | undefined;
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
    db.prepare(
      `INSERT INTO webhook_deliveries(id,subscription_id,event_id,kind,payload,created_at,available_at)
      VALUES(?,?,?,'run.stopped',?,?,?) ON CONFLICT(subscription_id,event_id) DO NOTHING`,
    ).run(
      payload.id,
      subscription.id,
      event.id,
      JSON.stringify(payload),
      event.created_at,
      event.created_at,
    );
  }
}
