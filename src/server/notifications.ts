import { Router } from "express";
import { z } from "zod";
import webpush from "web-push";
import { db, id, now } from "./db.js";
import { seal, unseal } from "./secrets.js";
import { Problem } from "./domain.js";
import { resultUrl } from "./feed.js";

// Subscriptions are browser-issued URLs, not arbitrary outbound webhooks.
export function pushEndpoint(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      (url.hostname === "fcm.googleapis.com" ||
        url.hostname === "updates.push.services.mozilla.com" ||
        url.hostname.endsWith(".push.apple.com") ||
        url.hostname.endsWith(".notify.windows.com"))
    );
  } catch {
    return false;
  }
}
const endpointSchema = z
  .string()
  .max(4096)
  .refine(pushEndpoint, "Unsupported phone notification service");
const subscriptionSchema = z.object({
  endpoint: endpointSchema,
  keys: z.object({
    p256dh: z
      .string()
      .regex(/^[A-Za-z0-9_-]{87}=?$/)
      .refine((value) => {
        const key = Buffer.from(value, "base64url");
        return key.length === 65 && key[0] === 4;
      }),
    auth: z.string().regex(/^[A-Za-z0-9_-]{22}(==)?$/),
  }),
});

export function notificationKeys() {
  return db
    .transaction(() => {
      let row = db
        .prepare(
          "SELECT public_key,private_key FROM push_config WHERE singleton=1",
        )
        .get() as { public_key: string; private_key: string } | undefined;
      if (!row) {
        const keys = webpush.generateVAPIDKeys();
        row = {
          public_key: keys.publicKey,
          private_key: seal(keys.privateKey, "web-push"),
        };
        db.prepare("INSERT INTO push_config VALUES(1,?,?)").run(
          row.public_key,
          row.private_key,
        );
      }
      return {
        publicKey: row.public_key,
        privateKey: unseal(row.private_key, "web-push"),
      };
    })
    .immediate();
}

export const notifications = Router();
notifications.get("/notifications", (_req, res) => {
  res.json({
    publicKey: notificationKeys().publicKey,
    endpoints: (
      db
        .prepare("SELECT endpoint FROM push_subscriptions WHERE owner_id=?")
        .all(res.locals.owner) as { endpoint: string }[]
    ).map((s) => s.endpoint),
  });
});
notifications.post("/notifications/subscriptions", (req, res) => {
  const subscription = subscriptionSchema.parse(req.body);
  const owner = res.locals.owner;
  db.transaction(() => {
    const existing = db
      .prepare("SELECT id,owner_id FROM push_subscriptions WHERE endpoint=?")
      .get(subscription.endpoint) as
      { id: string; owner_id: string } | undefined;
    if (existing && existing.owner_id !== owner)
      throw new Problem(
        409,
        "This device is subscribed to a different workspace. Disable its notifications first.",
      );
    if (
      !existing &&
      (
        db
          .prepare("SELECT count(*) n FROM push_subscriptions WHERE owner_id=?")
          .get(owner) as { n: number }
      ).n >= 20
    )
      throw new Problem(
        409,
        "Too many notification devices for this workspace",
      );
    db.prepare(
      "INSERT INTO push_subscriptions VALUES(?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET subscription=excluded.subscription",
    ).run(
      existing?.id || id(),
      owner,
      subscription.endpoint,
      seal(JSON.stringify(subscription), owner),
      now(),
    );
  }).immediate();
  res.status(201).json({ ok: true });
});
notifications.delete("/notifications/subscriptions", (req, res) => {
  const { endpoint } = z.object({ endpoint: endpointSchema }).parse(req.body);
  db.prepare(
    "DELETE FROM push_subscriptions WHERE endpoint=? AND owner_id=?",
  ).run(endpoint, res.locals.owner);
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
// Claim with a lease so restart/retry and multiple worker processes cannot send
// the same result concurrently. A notification tag also replaces duplicates if
// the push provider accepted a request just before a connection was lost.
export async function deliverNotifications(send = webpush.sendNotification) {
  const jobs = db
    .transaction(() => {
      const results = (
        db
          .prepare(
            `SELECT d.subscription_id,d.artifact_id,d.attempts,s.subscription,s.owner_id,a.title,g.name,a.conversation_id,json_extract(a.metadata,'$.messageId') message_id FROM push_deliveries d
      JOIN push_subscriptions s ON s.id=d.subscription_id
      JOIN artifacts a ON a.id=d.artifact_id LEFT JOIN agents g ON g.id=a.agent_id
      WHERE d.delivered_at IS NULL AND d.available_at<=? AND d.attempts<${MAX_ATTEMPTS} ORDER BY d.available_at LIMIT 4`,
          )
          .all(now()) as {
          subscription_id: string;
          artifact_id: string;
          attempts: number;
          subscription: string;
          owner_id: string;
          title: string;
          name: string | null;
          conversation_id: string | null;
          message_id: string | null;
        }[]
      ).map(
        (job): Delivery => ({
          subscription_id: job.subscription_id,
          subscription: job.subscription,
          owner_id: job.owner_id,
          attempts: job.attempts,
          artifact_id: job.artifact_id,
          message_key: null,
          payload: {
            title: job.name
              ? `@${job.name} has a new result`
              : "New result in Loop",
            body: job.title.slice(0, 140),
            tag: `loop-result-${job.artifact_id}`,
            url: resultUrl({
              id: job.artifact_id,
              conversation_id: job.conversation_id,
              message_id: job.message_id,
            }),
          },
        }),
      );
      const messages = (
        db
          .prepare(
            `SELECT m.*,s.subscription,s.owner_id FROM push_messages m
      JOIN push_subscriptions s ON s.id=m.subscription_id
      WHERE m.delivered_at IS NULL AND m.available_at<=? AND m.attempts<${MAX_ATTEMPTS} ORDER BY m.available_at LIMIT 4`,
          )
          .all(now()) as {
          subscription_id: string;
          message_key: string;
          title: string;
          body: string;
          url: string;
          attempts: number;
          subscription: string;
          owner_id: string;
        }[]
      ).map(
        (job): Delivery => ({
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
        }),
      );
      for (const job of results)
        db.prepare(
          "UPDATE push_deliveries SET attempts=attempts+1,available_at=? WHERE subscription_id=? AND artifact_id=?",
        ).run(now() + 60000, job.subscription_id, job.artifact_id);
      for (const job of messages)
        db.prepare(
          "UPDATE push_messages SET attempts=attempts+1,available_at=? WHERE subscription_id=? AND message_key=?",
        ).run(now() + 60000, job.subscription_id, job.message_key);
      return [...results, ...messages];
    })
    .immediate();
  if (!jobs.length) return;
  const keys = notificationKeys();
  const settle = (job: Delivery, sql: string, ...values: unknown[]) =>
    job.artifact_id
      ? db
          .prepare(
            `UPDATE push_deliveries SET ${sql} WHERE subscription_id=? AND artifact_id=?`,
          )
          .run(...values, job.subscription_id, job.artifact_id)
      : db
          .prepare(
            `UPDATE push_messages SET ${sql} WHERE subscription_id=? AND message_key=?`,
          )
          .run(...values, job.subscription_id, job.message_key);
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
        settle(job, "delivered_at=?", now());
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410)
          db.prepare("DELETE FROM push_subscriptions WHERE id=?").run(
            job.subscription_id,
          );
        else
          settle(
            job,
            "available_at=?",
            now() + Math.min(3600000, 60000 * 2 ** job.attempts),
          );
        // Never log endpoint URLs or subscription encryption keys.
      }
    }),
  );
  for (const table of ["push_deliveries", "push_messages"])
    db.prepare(
      `DELETE FROM ${table} WHERE delivered_at<? OR (attempts>=${MAX_ATTEMPTS} AND available_at<?)`,
    ).run(now() - 7 * 86400000, now() - 7 * 86400000);
}
