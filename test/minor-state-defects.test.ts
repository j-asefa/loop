import { it, expect, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dbDir = mkdtempSync(join(tmpdir(), "minor-state-defects-"));
process.env.LOOP_DATA_DIR = dbDir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { webhookOutcome } = await import("../src/server/webhooks");
const { seal } = await import("../src/server/secrets");
import * as pushSubscriptionsQueries from "../src/server/sql/push-subscriptions";

afterAll(() => {
  db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

it("opens only the isolated fixture database", () => {
  expect(db.name).toBe(join(dbDir, "loop.db"));
});

const p256dh = () =>
  Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString("base64url");
const auth = () => randomBytes(16).toString("base64url");
const subscription = () => ({
  endpoint:
    "https://fcm.googleapis.com/fcm/send/" + randomBytes(8).toString("hex"),
  keys: { p256dh: p256dh(), auth: auth() },
});

it("a later pre-dispatch failure keeps an earlier uncertain webhook outcome", () => {
  // Attempt 1 was dispatched but unconfirmed: outcome 'uncertain'.
  // A later attempt that fails before dispatch must not downgrade that to
  // 'unattempted'/'blocked', or settings would hide that the receiver may
  // hold the delivery ID.
  expect(webhookOutcome("uncertain", false, false, null, false)).toBe(
    "uncertain",
  );
  expect(webhookOutcome("uncertain", false, true, null, false)).toBe(
    "uncertain",
  );
  // A delivery that has never reached the receiver is still 'unattempted'.
  expect(webhookOutcome("unattempted", false, false, null, false)).toBe(
    "unattempted",
  );
  expect(webhookOutcome("unattempted", false, true, null, false)).toBe(
    "blocked",
  );
  // A prior 'rejected' (the receiver saw the delivery and refused it) is also
  // not downgraded by a later pre-dispatch failure.
  expect(webhookOutcome("rejected", false, false, null, false)).toBe(
    "rejected",
  );
  expect(webhookOutcome("rejected", false, true, null, false)).toBe("rejected");
  // A definitive receiver response replaces it.
  expect(webhookOutcome("uncertain", false, false, 400, false)).toBe(
    "rejected",
  );
  expect(webhookOutcome("uncertain", true, false, 200, true)).toBe("accepted");
  expect(webhookOutcome("uncertain", false, false, null, true)).toBe(
    "uncertain",
  );
});

it("a stale 404/410 does not delete a push subscription that was re-subscribed", () => {
  const owner = "push-owner";
  const original = subscription();
  const resealed = subscription();
  // Re-subscribing the same endpoint keeps the same id but fresh keys.
  resealed.endpoint = original.endpoint;
  const sealedOriginal = seal(JSON.stringify(original), owner);
  const sealedNew = seal(JSON.stringify(resealed), owner);
  const sid = id();
  pushSubscriptionsQueries.upsert(
    db,
    sid,
    owner,
    original.endpoint,
    sealedOriginal,
    now(),
  );
  // The stored subscription still matches the delivery the 404/410 rejected:
  // the atomic delete removes it.
  pushSubscriptionsQueries.removeIfSubscription(db, sid, sealedOriginal);
  expect(pushSubscriptionsQueries.byEndpoint(db, original.endpoint)).toBe(
    undefined,
  );
  // The browser re-subscribed the same endpoint before the 404 arrived: the
  // new keys stay even though the old delivery's id still matches.
  pushSubscriptionsQueries.upsert(
    db,
    sid,
    owner,
    original.endpoint,
    sealedNew,
    now(),
  );
  pushSubscriptionsQueries.removeIfSubscription(db, sid, sealedOriginal);
  expect(
    pushSubscriptionsQueries.byEndpoint(db, original.endpoint),
  ).toBeDefined();
});
