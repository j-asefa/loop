import { createHash, createHmac, randomUUID } from "node:crypto";
import { db, now } from "./db.js";
import { Problem } from "./domain.js";
import { seal, unseal } from "./secrets.js";
import {
  WebhookCreate,
  WebhookDelivery,
  WebhookPing,
  WebhookSubscription,
  type WebhookSubscription as Subscription,
} from "../shared/webhooks.js";
import {
  postWebhook,
  webhookDestination,
  webhookPolicy,
  WebhookDestinationRefused,
} from "./webhook-network.js";

type SubscriptionRow = {
  id: string;
  owner_id: string;
  url: string;
  secret_sealed: string;
  creation_digest: string;
  kinds: string;
  local: number;
  state: Subscription["state"];
  created_at: number;
  activated_at: number | null;
  revoked_at: number | null;
  failed_at: number | null;
  last_delivered_at: number | null;
  last_status: number | null;
  last_error: string | null;
  last_attempts: number;
};
type DeliveryRow = {
  id: string;
  subscription_id: string;
  event_id: number | null;
  kind: "run.stopped" | "control";
  purpose: "activation" | "test" | null;
  request_id: string | null;
  payload: string;
  attempts: number;
  available_at: number;
  leased_until: number | null;
  lease_id: string | null;
  dispatch_started_at: number | null;
  delivered_at: number | null;
  last_status: number | null;
  last_error: string | null;
  outcome: WebhookDelivery["outcome"];
  exhausted: number;
  created_at: number;
};
const RETRY_MS = [30000, 60000, 300000, 900000, 3600000];
const LEASE_MS = 60000;
const digest = (input: unknown) =>
  createHash("sha256").update(JSON.stringify(input)).digest("hex");
function owned(owner: string, id: string) {
  const row = db
    .prepare("SELECT * FROM webhook_subscriptions WHERE id=? AND owner_id=?")
    .get(id, owner) as SubscriptionRow | undefined;
  if (!row) throw new Problem(404, "Webhook not found");
  return row;
}
function delivery(id: string) {
  return db.prepare("SELECT * FROM webhook_deliveries WHERE id=?").get(id) as
    DeliveryRow | undefined;
}
function publicDelivery(row: DeliveryRow) {
  return WebhookDelivery.parse({
    ...row,
    exhausted: !!row.exhausted,
    in_flight: row.leased_until !== null && row.leased_until > now(),
  });
}
function publicSubscription(row: SubscriptionRow) {
  const activation = db
    .prepare(
      "SELECT * FROM webhook_deliveries WHERE subscription_id=? AND purpose='activation'",
    )
    .get(row.id) as DeliveryRow | undefined;
  return WebhookSubscription.parse({
    ...row,
    kinds: JSON.parse(row.kinds),
    local: !!row.local,
    activation: activation ? publicDelivery(activation) : null,
  });
}
export function listWebhooks(owner: string) {
  const rows = db
    .prepare(
      "SELECT * FROM webhook_subscriptions WHERE owner_id=? ORDER BY created_at DESC,id DESC",
    )
    .all(owner) as SubscriptionRow[];
  return {
    policy: webhookPolicy(),
    subscriptions: rows.map(publicSubscription),
  };
}
export function webhookHistory(owner: string, id: string) {
  owned(owner, id);
  return (
    db
      .prepare(
        "SELECT * FROM webhook_deliveries WHERE subscription_id=? ORDER BY created_at DESC,id DESC LIMIT 50",
      )
      .all(id) as DeliveryRow[]
  ).map(publicDelivery);
}
function pendingPing(
  id: string,
  request: string,
  purpose: "activation" | "test",
) {
  const time = now(),
    payload = WebhookPing.parse({
      id: randomUUID(),
      type: "ping",
      sent_at: time,
    });
  db.prepare(
    `INSERT INTO webhook_deliveries(id,subscription_id,kind,purpose,request_id,payload,created_at,available_at)
    VALUES(?,?,'control',?,?,?,?,?)`,
  ).run(payload.id, id, purpose, request, JSON.stringify(payload), time, time);
  return payload.id;
}
function priorRequest(
  owner: string,
  id: string,
  request: string,
  action: string,
  input: unknown,
) {
  const row = db
    .prepare("SELECT * FROM webhook_requests WHERE owner_id=? AND request_id=?")
    .get(owner, request) as
    | {
        subscription_id: string;
        action: string;
        digest: string;
        result_id: string | null;
      }
    | undefined;
  if (
    row &&
    (row.subscription_id !== id ||
      row.action !== action ||
      row.digest !== digest(input))
  )
    throw new Problem(409, "Request ID belongs to another webhook operation");
  return row;
}
function remember(
  owner: string,
  id: string,
  request: string,
  action: string,
  input: unknown,
  result: string | null = null,
) {
  db.prepare("INSERT INTO webhook_requests VALUES(?,?,?,?,?,?)").run(
    owner,
    request,
    id,
    action,
    digest(input),
    result,
  );
}
export async function createWebhook(owner: string, input: unknown) {
  const parsed = WebhookCreate.parse(input);
  const options = { ...parsed, kinds: [...new Set(parsed.kinds)].sort() };
  const existing = db
    .prepare("SELECT * FROM webhook_subscriptions WHERE id=?")
    .get(options.request_id) as SubscriptionRow | undefined;
  if (existing) {
    if (
      existing.owner_id !== owner ||
      existing.creation_digest !== digest(options)
    )
      throw new Problem(409, "Request ID belongs to another webhook creation");
    return {
      subscription: publicSubscription(existing),
      secret: options.secret,
    };
  }
  const destination = await webhookDestination(options.url);
  const control = db
    .transaction(() => {
      const collision = db
        .prepare(
          "SELECT owner_id,creation_digest FROM webhook_subscriptions WHERE id=?",
        )
        .get(options.request_id) as
        { owner_id: string; creation_digest: string } | undefined;
      if (
        collision &&
        (collision.owner_id !== owner ||
          collision.creation_digest !== digest(options))
      )
        throw new Problem(
          409,
          "Request ID belongs to another webhook creation",
        );
      const raced = priorRequest(
        owner,
        options.request_id,
        options.request_id,
        "create",
        options,
      );
      if (raced) return raced.result_id!;
      const count = db
        .prepare(
          "SELECT count(*) n FROM webhook_subscriptions WHERE owner_id=? AND state<>'revoked'",
        )
        .get(owner) as { n: number };
      if (count.n >= 50)
        throw new Problem(429, "Revoke a webhook before creating another");
      db.prepare(
        `INSERT INTO webhook_subscriptions(id,owner_id,url,secret_sealed,creation_digest,kinds,local,state,created_at)
      VALUES(?,?,?,?,?,?,?,'pending_activation',?)`,
      ).run(
        options.request_id,
        owner,
        destination.url.href,
        seal(options.secret, "webhook:" + owner + ":" + options.request_id),
        digest(options),
        JSON.stringify(options.kinds),
        destination.local ? 1 : 0,
        now(),
      );
      const ping = pendingPing(
        options.request_id,
        options.request_id,
        "activation",
      );
      remember(
        owner,
        options.request_id,
        options.request_id,
        "create",
        options,
        ping,
      );
      return ping;
    })
    .immediate();
  // Persistence precedes all receiver IO. A disconnect or process death leaves
  // the ordinary worker claim able to finish the same activation delivery.
  await deliverWebhooks(undefined, control);
  return {
    subscription: publicSubscription(owned(owner, options.request_id)),
    secret: options.secret,
  };
}
export function updateWebhook(
  owner: string,
  id: string,
  request: string,
  kinds: "run.stopped"[],
) {
  const input = [...new Set(kinds)].sort();
  return db
    .transaction(() => {
      const row = owned(owner, id);
      if (priorRequest(owner, id, request, "update", input))
        return publicSubscription(row);
      if (row.state === "revoked")
        throw new Problem(409, "This webhook is revoked");
      db.prepare("UPDATE webhook_subscriptions SET kinds=? WHERE id=?").run(
        JSON.stringify(input),
        id,
      );
      remember(owner, id, request, "update", input);
      return publicSubscription(owned(owner, id));
    })
    .immediate();
}
export function revokeWebhook(owner: string, id: string, request: string) {
  return db
    .transaction(() => {
      const row = owned(owner, id);
      if (priorRequest(owner, id, request, "revoke", null))
        return publicSubscription(row);
      db.prepare(
        "UPDATE webhook_subscriptions SET state='revoked',revoked_at=COALESCE(revoked_at,?) WHERE id=?",
      ).run(now(), id);
      // A claim that has not started dispatch may be cancelled truthfully. An
      // in-flight send retains its lease and its eventual observed outcome.
      db.prepare(
        `UPDATE webhook_deliveries SET exhausted=1,
      outcome=CASE WHEN dispatch_started_at IS NULL THEN 'cancelled' ELSE
        CASE WHEN outcome='sending' THEN 'uncertain' ELSE outcome END END,
      last_error=CASE WHEN dispatch_started_at IS NULL THEN 'Revoked before dispatch' ELSE last_error END
      WHERE subscription_id=? AND delivered_at IS NULL`,
      ).run(id);
      remember(owner, id, request, "revoke", null);
      return publicSubscription(owned(owner, id));
    })
    .immediate();
}
export async function testWebhook(owner: string, id: string, request: string) {
  const row = owned(owner, id),
    previous = priorRequest(owner, id, request, "test", null);
  if (previous)
    return {
      subscription: publicSubscription(row),
      delivery: publicDelivery(delivery(previous.result_id!)!),
    };
  if (row.state === "revoked" || row.state === "pending_activation")
    throw new Problem(409, "Retry activation before testing this webhook");
  await webhookDestination(row.url);
  const control = db
    .transaction(() => {
      const current = owned(owner, id),
        raced = priorRequest(owner, id, request, "test", null);
      if (raced) return raced.result_id!;
      if (current.state === "revoked" || current.state === "pending_activation")
        throw new Problem(409, "Webhook cannot be tested in this state");
      const ping = pendingPing(id, request, "test");
      remember(owner, id, request, "test", null, ping);
      return ping;
    })
    .immediate();
  await deliverWebhooks(undefined, control);
  return {
    subscription: publicSubscription(owned(owner, id)),
    delivery: publicDelivery(delivery(control)!),
  };
}
export async function retryWebhook(owner: string, id: string, request: string) {
  const row = owned(owner, id);
  if (priorRequest(owner, id, request, "retry", null))
    return publicSubscription(row);
  if (row.state === "revoked")
    throw new Problem(409, "This webhook is revoked");
  await webhookDestination(row.url);
  return db
    .transaction(() => {
      const current = owned(owner, id);
      if (priorRequest(owner, id, request, "retry", null))
        return publicSubscription(current);
      if (current.state === "revoked")
        throw new Problem(409, "This webhook is revoked");
      if (
        db
          .prepare(
            "SELECT 1 FROM webhook_deliveries WHERE subscription_id=? AND leased_until>? LIMIT 1",
          )
          .get(id, now())
      )
        throw new Problem(
          409,
          "A delivery is still in flight; wait for its outcome",
        );
      if (current.state === "failed")
        db.prepare(
          "UPDATE webhook_subscriptions SET state='active',failed_at=NULL WHERE id=?",
        ).run(id);
      db.prepare(
        `UPDATE webhook_deliveries SET attempts=0,available_at=?,leased_until=NULL,lease_id=NULL,exhausted=0
      WHERE subscription_id=? AND delivered_at IS NULL AND (?<>'pending_activation' OR purpose='activation')`,
      ).run(now(), id, current.state);
      remember(owner, id, request, "retry", null);
      // Merely re-arms the same rows. Only an accepted activation ping can activate.
      return publicSubscription(owned(owner, id));
    })
    .immediate();
}

function eligible(subscription: SubscriptionRow, job: DeliveryRow) {
  return subscription.state === "pending_activation"
    ? job.purpose === "activation"
    : subscription.state === "active" ||
        (subscription.state === "failed" && job.purpose === "test");
}
function exhaust(
  subscription: SubscriptionRow,
  job: DeliveryRow,
  message: string,
  status: number | null,
) {
  db.prepare(
    "UPDATE webhook_deliveries SET exhausted=1,last_error=?,last_status=?,lease_id=NULL,leased_until=NULL WHERE id=?",
  ).run(message, status, job.id);
  // Later attempts have their own history. Preserve every diagnostic field of
  // the first exhausted event until the owner explicitly retries the backlog.
  if (subscription.state === "failed") return;
  db.prepare(
    `UPDATE webhook_subscriptions SET state=CASE WHEN state='active' AND ?='run.stopped' THEN 'failed' ELSE state END,
    failed_at=CASE WHEN state IN ('active','failed') AND ?='run.stopped' THEN ? ELSE failed_at END,last_error=?,last_status=?,last_attempts=? WHERE id=? AND state<>'revoked'`,
  ).run(
    job.kind,
    job.kind,
    now(),
    message,
    status,
    job.attempts,
    subscription.id,
  );
}
/** Claims commit before resolution or connection. The random lease identity
 * fences a late callback from a worker whose lease was reclaimed. */
export function claimWebhooks(only?: string) {
  return db
    .transaction(() => {
      const jobs = db
        .prepare(
          `SELECT d.* FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id=d.subscription_id
      WHERE d.delivered_at IS NULL AND d.exhausted=0 AND d.available_at<=? AND (d.leased_until IS NULL OR d.leased_until<=?)
      AND (? IS NULL OR d.id=?) AND (s.state='active' OR (s.state='pending_activation' AND d.purpose='activation') OR (s.state='failed' AND d.purpose='test'))
      ORDER BY d.available_at,d.id LIMIT 4`,
        )
        .all(now(), now(), only ?? null, only ?? null) as DeliveryRow[];
      return jobs.flatMap((job) => {
        if (job.dispatch_started_at !== null && job.outcome === "sending") {
          job.outcome = "uncertain";
          job.last_status = null;
          db.prepare(
            "UPDATE webhook_deliveries SET outcome='uncertain',last_status=NULL,last_error='Worker stopped before confirming delivery' WHERE id=?",
          ).run(job.id);
        }
        if (job.attempts >= 6) {
          const subscription = db
            .prepare("SELECT * FROM webhook_subscriptions WHERE id=?")
            .get(job.subscription_id) as SubscriptionRow;
          exhaust(
            subscription,
            job,
            "Delivery attempts exhausted; the last outcome may be uncertain",
            job.last_status,
          );
          return [];
        }
        const lease = randomUUID();
        db.prepare(
          "UPDATE webhook_deliveries SET lease_id=?,leased_until=? WHERE id=?",
        ).run(lease, now() + LEASE_MS, job.id);
        return [{ id: job.id, lease }];
      });
    })
    .immediate();
}
export function webhookSignature(
  secret: string,
  timestamp: string,
  body: string,
) {
  return (
    "v1=" +
    createHmac("sha256", secret)
      .update(timestamp + "." + body)
      .digest("hex")
  );
}
async function deliverClaim(
  claim: { id: string; lease: string },
  stopped?: AbortSignal,
) {
  const initial = delivery(claim.id);
  if (!initial || initial.lease_id !== claim.lease) return;
  const subscription = db
    .prepare("SELECT * FROM webhook_subscriptions WHERE id=?")
    .get(initial.subscription_id) as SubscriptionRow;
  const signal = AbortSignal.any([
    AbortSignal.timeout(10000),
    ...(stopped ? [stopped] : []),
  ]);
  let status: number | null = null,
    failure: string | null = null,
    permanent = false,
    dispatched = false;
  try {
    const destination = await webhookDestination(subscription.url, signal);
    const secret = unseal(
      subscription.secret_sealed,
      "webhook:" + subscription.owner_id + ":" + subscription.id,
    );
    dispatched = db
      .transaction(() => {
        const current = owned(subscription.owner_id, subscription.id),
          job = delivery(claim.id);
        if (!job || job.lease_id !== claim.lease) return false;
        if (
          !eligible(current, job) ||
          current.state === "revoked" ||
          job.exhausted ||
          signal.aborted
        ) {
          db.prepare(
            "UPDATE webhook_deliveries SET lease_id=NULL,leased_until=NULL WHERE id=? AND lease_id=?",
          ).run(job.id, claim.lease);
          return false;
        }
        db.prepare(
          "UPDATE webhook_deliveries SET attempts=attempts+1,dispatch_started_at=?,outcome='sending' WHERE id=? AND lease_id=?",
        ).run(now(), job.id, claim.lease);
        return true;
      })
      .immediate();
    if (!dispatched) return;
    const timestamp = String(Math.floor(now() / 1000));
    status = await postWebhook(
      destination,
      initial.payload,
      {
        "content-type": "application/json",
        "x-loop-delivery": initial.id,
        "x-loop-event": initial.kind,
        "x-loop-timestamp": timestamp,
        "x-loop-signature": webhookSignature(
          secret,
          timestamp,
          initial.payload,
        ),
      },
      signal,
    );
    if (status < 200 || status >= 300)
      failure = "Receiver returned HTTP " + status;
  } catch (error) {
    permanent = error instanceof WebhookDestinationRefused;
    failure = permanent
      ? "Receiver destination is no longer allowed; retry requires a permitted destination"
      : dispatched
        ? "Delivery could not be confirmed; the receiver may have received it"
        : "Could not prepare the receiver connection";
  }
  if (!dispatched && stopped?.aborted) {
    // Stopping the worker is not a failed receiver attempt. No external effect
    // began, so release only this claim and preserve its retry budget/outcome.
    db.prepare(
      "UPDATE webhook_deliveries SET lease_id=NULL,leased_until=NULL WHERE id=? AND lease_id=?",
    ).run(claim.id, claim.lease);
    return;
  }
  db.transaction(() => {
    const job = delivery(claim.id),
      current = owned(subscription.owner_id, subscription.id);
    if (!job || job.lease_id !== claim.lease) return;
    // Resolution failures also consume an attempt, bounding DNS/unseal failures.
    const attempts = job.attempts + (dispatched ? 0 : 1),
      accepted = status !== null && status >= 200 && status < 300;
    const exhausted = current.state === "revoked" || permanent || attempts >= 6;
    const outcome = accepted
      ? "accepted"
      : permanent
        ? "blocked"
        : status !== null
          ? "rejected"
          : dispatched
            ? "uncertain"
            : "unattempted";
    db.prepare(
      `UPDATE webhook_deliveries SET attempts=?,leased_until=NULL,lease_id=NULL,delivered_at=?,last_status=?,last_error=?,outcome=?,exhausted=?,available_at=? WHERE id=? AND lease_id=?`,
    ).run(
      attempts,
      accepted ? now() : null,
      status,
      failure,
      outcome,
      exhausted ? 1 : 0,
      now() + (RETRY_MS[Math.min(attempts - 1, RETRY_MS.length - 1)] ?? 30000),
      job.id,
      claim.lease,
    );
    const keepFailure = current.state === "failed";
    db.prepare(
      `UPDATE webhook_subscriptions SET last_status=?,last_error=?,last_attempts=?,last_delivered_at=CASE WHEN ? THEN ? ELSE last_delivered_at END,
      state=CASE WHEN ? AND ?='activation' AND state='pending_activation' THEN 'active' ELSE state END,
      activated_at=CASE WHEN ? AND ?='activation' AND state='pending_activation' THEN ? ELSE activated_at END WHERE id=?`,
    ).run(
      keepFailure ? current.last_status : status,
      keepFailure ? current.last_error : failure,
      keepFailure ? current.last_attempts : attempts,
      accepted ? 1 : 0,
      now(),
      accepted ? 1 : 0,
      job.purpose,
      accepted ? 1 : 0,
      job.purpose,
      now(),
      current.id,
    );
    if (!accepted && exhausted && current.state !== "revoked")
      exhaust(
        current,
        { ...job, attempts },
        failure || "Delivery attempts exhausted",
        status,
      );
  }).immediate();
}
export async function deliverWebhooks(signal?: AbortSignal, only?: string) {
  if (signal?.aborted) return;
  const results = await Promise.allSettled(
    claimWebhooks(only).map((job) => deliverClaim(job, signal)),
  );
  for (const result of results)
    if (result.status === "rejected") throw result.reason;
}
