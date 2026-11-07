import * as pushConfigQueries from "./sql/push-config.js";
import * as pushSubscriptionsQueries from "./sql/push-subscriptions.js";
import * as pushPreferencesQueries from "./sql/push-preferences.js";
import * as pushDeliveriesQueries from "./sql/push-deliveries.js";
import * as pushMessagesQueries from "./sql/push-messages.js";
import { workspaceApi } from "../shared/workspace-api.js";
import { registrar } from "./registrar.js";
import { plainPreview } from "../shared/text.js";

import webpush from "web-push";
import { db, id, now } from "./db.js";
import { seal, unseal } from "./secrets.js";
import { Problem } from "./domain.js";

import { PushSubscription as subscriptionSchema } from "../shared/team-contract-schemas.js";
export { pushEndpoint } from "../shared/team-contract-schemas.js";

export function notificationKeys() {
  return db
    .transaction(() => {
      let row = pushConfigQueries.keys(db) as
        { public_key: string; private_key: string } | undefined;
      if (!row) {
        const keys = webpush.generateVAPIDKeys();
        row = {
          public_key: keys.publicKey,
          private_key: seal(keys.privateKey, "web-push"),
        };
        pushConfigQueries.insert(db, row.public_key, row.private_key);
      }
      return {
        publicKey: row.public_key,
        privateKey: unseal(row.private_key, "web-push"),
      };
    })
    .immediate();
}

function devicePreferences(owner: string) {
  const rows = pushSubscriptionsQueries.preferences(db, owner) as {
    endpoint: string;
    needsYou: number;
    completed: number;
    reminders: number;
    social: number;
  }[];
  return rows.map((row) => ({
    endpoint: row.endpoint,
    preferences: {
      needsYou: !!row.needsYou,
      completed: !!row.completed,
      reminders: !!row.reminders,
      social: !!row.social,
    },
  }));
}
const routes = registrar("notifications");
export const notifications = routes.mount;
routes.on(workspaceApi.notifications, (_req, res) => {
  res.json({
    publicKey: notificationKeys().publicKey,
    devices: devicePreferences(res.locals.owner),
    endpoints: (
      pushSubscriptionsQueries.endpoints(db, res.locals.owner) as {
        endpoint: string;
      }[]
    ).map((s) => s.endpoint),
  });
});
routes.on(workspaceApi.notificationSubscribe, (req, res) => {
  const subscription = subscriptionSchema.parse(req.body);
  const preferences = req.body.preferences;
  const owner = res.locals.owner;
  db.transaction(() => {
    const existing = pushSubscriptionsQueries.byEndpoint(
      db,
      subscription.endpoint,
    ) as { id: string; owner_id: string } | undefined;
    if (existing && existing.owner_id !== owner)
      throw new Problem(
        409,
        "This device is subscribed to a different workspace. Disable its notifications first.",
      );
    if (
      !existing &&
      (pushSubscriptionsQueries.count(db, owner) as { n: number }).n >= 20
    )
      throw new Problem(
        409,
        "Too many notification devices for this workspace",
      );
    pushSubscriptionsQueries.upsert(
      db,
      existing?.id || id(),
      owner,
      subscription.endpoint,
      seal(JSON.stringify(subscription), owner),
      now(),
    );
    if (preferences) {
      const device = pushSubscriptionsQueries.ownedEndpoint(
        db,
        subscription.endpoint,
        owner,
      ) as { id: string };
      pushPreferencesQueries.upsert(
        db,
        device.id,
        Number(preferences.needsYou),
        Number(preferences.completed),
        Number(preferences.reminders),
        Number(preferences.social),
      );
    }
  }).immediate();
  res.status(201).json({ ok: true });
});
routes.on(workspaceApi.notificationUnsubscribe, (req, res) => {
  const { endpoint } = req.body;
  pushSubscriptionsQueries.removeEndpoint(db, endpoint, res.locals.owner);
  res.json({ ok: true });
});

type Delivery = {
  subscription_id: string;
  subscription: string;
  owner_id: string;
  attempts: number;
  // Result notifications are keyed by artifact, app messages by message key.
  artifact_id: string | null;
  message_key: string | null;
  payload: { title: string; body: string; tag: string; url: string };
};
const MAX_ATTEMPTS = 5;

// What a result notification says. Lock screens show a line or two of the
// body, so it leads with the answer itself rather than repeating the prompt:
// the heading names the agent and the thread, the body is the start of the
// result as plain text (no Markdown), or what kind of result it is.
const MADE: Record<string, string> = {
  image: "Made an image",
  chart: "Made a chart",
  diagram: "Made a diagram",
  table: "Made a table",
  html: "Made a page",
  code: "Wrote code",
  github_pr: "Read a pull request",
};
const TEXT_KINDS = new Set(["markdown", "text", "message"]);
export function resultNotification(result: {
  name: string | null;
  thread: string | null;
  title: string;
  kind: string;
  content: string;
}) {
  const topic = plainPreview(result.thread || result.title, 60);
  const title = result.name
    ? `@${result.name}${topic ? " · " + topic : " has a new result"}`
    : topic || "New result in Loop";
  const answer = TEXT_KINDS.has(result.kind)
    ? plainPreview(result.content, 180)
    : "";
  const made = MADE[result.kind];
  const body =
    answer ||
    (made
      ? `${made}: ${plainPreview(result.title, 120)}`
      : plainPreview(result.title, 140)) ||
    "Your agent has finished some work.";
  return { title, body };
}
// Claim with a lease so restart/retry and multiple worker processes cannot send
// the same result concurrently. A notification tag also replaces duplicates if
// the push provider accepted a request just before a connection was lost.
export async function deliverNotifications(send = webpush.sendNotification) {
  const jobs = db
    .transaction(() => {
      const results = (
        pushDeliveriesQueries.due(db, now(), MAX_ATTEMPTS) as {
          subscription_id: string;
          artifact_id: string;
          attempts: number;
          subscription: string;
          owner_id: string;
          title: string;
          kind: string;
          content: string;
          thread: string | null;
          name: string | null;
          conversation_id: string | null;
          message_id: string | null;
        }[]
      ).map((job): Delivery => ({
        subscription_id: job.subscription_id,
        subscription: job.subscription,
        owner_id: job.owner_id,
        attempts: job.attempts,
        artifact_id: job.artifact_id,
        message_key: null,
        payload: {
          ...resultNotification(job),
          tag: `loop-result-${job.artifact_id}`,
          url: `/?artifact=${encodeURIComponent(job.artifact_id)}`,
        },
      }));
      const messages = (
        pushMessagesQueries.due(db, now(), MAX_ATTEMPTS) as {
          subscription_id: string;
          message_key: string;
          title: string;
          body: string;
          url: string;
          attempts: number;
          subscription: string;
          owner_id: string;
        }[]
      ).map((job): Delivery => ({
        subscription_id: job.subscription_id,
        subscription: job.subscription,
        owner_id: job.owner_id,
        attempts: job.attempts,
        artifact_id: null,
        message_key: job.message_key,
        // No action buttons: approvals are decided inside the locked app.
        payload: {
          title: job.title,
          body: job.body,
          tag: job.message_key,
          url: job.url,
        },
      }));
      for (const job of results)
        pushDeliveriesQueries.claim(
          db,
          now() + 60000,
          job.subscription_id,
          job.artifact_id,
        );
      for (const job of messages)
        pushMessagesQueries.claim(
          db,
          now() + 60000,
          job.subscription_id,
          job.message_key,
        );
      return [...results, ...messages];
    })
    .immediate();
  if (!jobs.length) return;
  const keys = notificationKeys();
  const settle = (
    job: Delivery,
    action: "delivered" | "retry",
    time: number,
  ) =>
    job.artifact_id
      ? pushDeliveriesQueries[action](
          db,
          time,
          job.subscription_id,
          job.artifact_id,
        )
      : pushMessagesQueries[action](
          db,
          time,
          job.subscription_id,
          job.message_key,
        );
  await Promise.all(
    jobs.map(async (job) => {
      try {
        const subscription = subscriptionSchema.parse(
          JSON.parse(unseal(job.subscription, job.owner_id)),
        );
        await send(subscription, JSON.stringify(job.payload), {
          vapidDetails: {
            subject:
              process.env.LOOP_PUSH_CONTACT ||
              "https://github.com/j-asefa/loop",
            ...keys,
          },
          TTL: 86400,
          urgency: "normal",
          timeout: 8000,
        });
        settle(job, "delivered", now());
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          // A browser that re-subscribed the same endpoint keeps the same id
          // but a newer sealed subscription; a stale 404/410 for an old key
          // must not delete it, or the new keys and queued pushes would be
          // lost. job.subscription is the stored sealed value read at the
          // claim JOIN, so one atomic statement removes it only if it still
          // matches the delivery that was rejected.
          pushSubscriptionsQueries.removeIfSubscription(
            db,
            job.subscription_id,
            job.subscription,
          );
        } else
          settle(
            job,
            "retry",
            now() + Math.min(3600000, 60000 * 2 ** job.attempts),
          );
        // Never log endpoint URLs or subscription encryption keys.
      }
    }),
  );
  pushDeliveriesQueries.prune(
    db,
    now() - 7 * 86400000,
    MAX_ATTEMPTS,
    now() - 7 * 86400000,
  );
  pushMessagesQueries.prune(
    db,
    now() - 7 * 86400000,
    MAX_ATTEMPTS,
    now() - 7 * 86400000,
  );
}
