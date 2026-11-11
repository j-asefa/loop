import * as webhookSubscriptionsQueries from "./sql/webhook-subscriptions.js";
import * as webhookDeliveriesQueries from "./sql/webhook-deliveries.js";
import * as webhookRequestsQueries from "./sql/webhook-requests.js";
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
  const row = webhookSubscriptionsQueries.owned(db, id, owner);
  if (!row) throw new Problem(404, "Webhook not found");
  return row;
}
function delivery(id: string) {
  return webhookDeliveriesQueries.byId(db, id) as DeliveryRow | undefined;
}
function publicDelivery(row: DeliveryRow) {
  return WebhookDelivery.parse({
    ...row,
    exhausted: !!row.exhausted,
    in_flight: row.leased_until !== null && row.leased_until > now(),
  });
}
function publicSubscription(row: SubscriptionRow) {
  const activation = webhookDeliveriesQueries.activation(db, row.id) as
    DeliveryRow | undefined;
  return WebhookSubscription.parse({
    ...row,
    kinds: JSON.parse(row.kinds),
    local: !!row.local,
    activation: activation ? publicDelivery(activation) : null,
  });
}
export function listWebhooks(owner: string) {
  const rows = webhookSubscriptionsQueries.forOwner(db, owner);
  return {
    policy: webhookPolicy(),
    subscriptions: rows.map(publicSubscription),
  };
}
export function webhookHistory(owner: string, id: string) {
  owned(owner, id);
  return (webhookDeliveriesQueries.history(db, id) as DeliveryRow[]).map(
    publicDelivery,
  );
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
  webhookDeliveriesQueries.insertControl(
    db,
    payload.id,
    id,
    purpose,
    request,
    JSON.stringify(payload),
    time,
  );
  return payload.id;
}
function priorRequest(
  owner: string,
  id: string,
  request: string,
  action: string,
  input: unknown,
) {
  const row = webhookRequestsQueries.prior(db, owner, request);
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
  webhookRequestsQueries.insert(
    db,
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
  const existing = webhookSubscriptionsQueries.byId(db, options.request_id);
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
      const collision = webhookSubscriptionsQueries.creation(
        db,
        options.request_id,
      );
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
      const count = webhookSubscriptionsQueries.activeCount(db, owner)!;
      if (count.n >= 50)
        throw new Problem(429, "Revoke a webhook before creating another");
      webhookSubscriptionsQueries.insert(
        db,
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
      webhookSubscriptionsQueries.setKinds(db, JSON.stringify(input), id);
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
      webhookSubscriptionsQueries.revoke(db, now(), id);
      // A claim that has not started dispatch may be cancelled truthfully. An
      // in-flight send retains its lease and its eventual observed outcome.
      webhookDeliveriesQueries.revokeSubscription(db, id);
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
      if (webhookDeliveriesQueries.leased(db, id, now()))
        throw new Problem(
          409,
          "A delivery is still in flight; wait for its outcome",
        );
      if (current.state === "failed")
        webhookSubscriptionsQueries.activate(db, id);
      webhookDeliveriesQueries.reset(db, now(), id, current.state);
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
  webhookDeliveriesQueries.exhaust(db, message, status, job.id);
  // Later attempts have their own history. Preserve every diagnostic field of
  // the first exhausted event until the owner explicitly retries the backlog.
  if (subscription.state === "failed") return;
  webhookSubscriptionsQueries.fail(
    db,
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
      const jobs = webhookDeliveriesQueries.due(
        db,
        now(),
        now(),
        only ?? null,
      ) as DeliveryRow[];
      return jobs.flatMap((job) => {
        if (job.dispatch_started_at !== null && job.outcome === "sending") {
          job.outcome = "uncertain";
          job.last_status = null;
          webhookDeliveriesQueries.uncertain(db, job.id);
        }
        if (job.attempts >= 6) {
          const subscription = webhookSubscriptionsQueries.byId(
            db,
            job.subscription_id,
          )!;
          exhaust(
            subscription,
            job,
            "Delivery attempts exhausted; the last outcome may be uncertain",
            job.last_status,
          );
          return [];
        }
        const lease = randomUUID();
        webhookDeliveriesQueries.lease(db, lease, now() + LEASE_MS, job.id);
        return [{ id: job.id, lease }];
      });
    })
    .immediate();
}
/** Delivery outcome for an attempt. An earlier attempt may already have
 * reached the receiver ('uncertain' dispatched without confirmation, or
 * 'rejected' with a receiver response), so a later attempt that fails before
 * dispatch must not downgrade that to 'unattempted'/'blocked', or settings
 * would hide that the receiver may hold the delivery ID. */
export function webhookOutcome(
  prior: string,
  accepted: boolean,
  permanent: boolean,
  status: number | null,
  dispatched: boolean,
): string {
  const reached = prior === "uncertain" || prior === "rejected";
  if (accepted) return "accepted";
  if (permanent) return reached ? prior : "blocked";
  if (status !== null) return "rejected";
  if (dispatched) return "uncertain";
  return reached ? prior : "unattempted";
}

function webhookSignature(secret: string, timestamp: string, body: string) {
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
  const subscription = webhookSubscriptionsQueries.byId(
    db,
    initial.subscription_id,
  )!;
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
          webhookDeliveriesQueries.release(db, job.id, claim.lease);
          return false;
        }
        webhookDeliveriesQueries.dispatch(db, now(), job.id, claim.lease);
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
    webhookDeliveriesQueries.release(db, claim.id, claim.lease);
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
    const outcome = webhookOutcome(
      job.outcome,
      accepted,
      permanent,
      status,
      dispatched,
    );
    webhookDeliveriesQueries.settle(
      db,
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
    webhookSubscriptionsQueries.settle(
      db,
      keepFailure ? current.last_status : status,
      keepFailure ? current.last_error : failure,
      keepFailure ? current.last_attempts : attempts,
      accepted ? 1 : 0,
      now(),
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
