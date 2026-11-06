import { readFile } from "node:fs/promises";
import { expect, it, onTestFinished } from "vitest";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import { createHmac, randomUUID } from "node:crypto";
import { cardsFixture } from "./helpers/cards-fixture";
import { integrationTokenRequest } from "../src/shared/card-access";
import {
  webhookRequest,
  WebhookCreated,
  WebhookDelivery,
  WebhookList,
  WebhookPayload,
  WebhookStop,
  WebhookSubscription,
} from "../src/shared/webhooks";

type Fixture = Awaited<ReturnType<typeof cardsFixture>>;
type Received = { req: IncomingMessage; res: ServerResponse; body: string };
async function receiver() {
  const received: Received[] = [];
  const effects: string[] = [],
    seen = new Set<string>();
  let status = 204,
    hold = false;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      received.push({ req, res, body });
      const payload = JSON.parse(body);
      if (
        payload.kind === "run.stopped" &&
        (hold || (status >= 200 && status < 300)) &&
        !seen.has(payload.id)
      ) {
        seen.add(payload.id);
        effects.push(payload.id);
      }
      if (!hold) {
        res.writeHead(
          status,
          status === 302 ? { location: "/redirect-target" } : {},
        );
        res.end();
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    url:
      "http://127.0.0.1:" +
      (server.address() as { port: number }).port +
      "/receiver",
    received,
    effects,
    status(value: number) {
      status = value;
    },
    hold(value: boolean) {
      hold = value;
    },
  };
}
// "public" routes a public HTTPS hostname to the local recording receiver
// through the virtual network; "local" posts to the loopback receiver directly.
async function fixture(network: "local" | "public" = "local") {
  const sink = await receiver();
  const f = await cardsFixture(
    false,
    network === "local" ? {} : { webhookReceiver: sink.url },
  );
  return {
    f,
    sink,
    destination:
      network === "local" ? sink.url : "https://webhook.fixture.test/receiver",
  };
}
async function create(f: Fixture, destination: string) {
  const request = webhookRequest(destination, ["run.stopped"]);
  const response = await f.request("/api/webhooks", {
    headers: f.browser,
    body: request,
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return { request, ...WebhookCreated.parse(await response.json()) };
}
async function list(f: Fixture) {
  const response = await f.request("/api/webhooks", { headers: f.browser });
  expect(response.status).toBe(200);
  return WebhookList.parse(await response.json());
}
async function history(f: Fixture, id: string) {
  const response = await f.request(`/api/webhooks/${id}/deliveries`, {
    headers: f.browser,
  });
  expect(response.status).toBe(200);
  return WebhookDelivery.array().parse(await response.json());
}
async function action(
  f: Fixture,
  id: string,
  name: "retry" | "revoke" | "test",
  request_id = randomUUID(),
) {
  return f.request(`/api/webhooks/${id}/${name}`, {
    headers: f.browser,
    body: { request_id },
  });
}
function due(f: Fixture, id: string) {
  f.db
    .prepare(
      "UPDATE webhook_deliveries SET available_at=0 WHERE subscription_id=? AND delivered_at IS NULL",
    )
    .run(id);
}
async function stop(
  f: Fixture,
  records: Awaited<ReturnType<Fixture["integrationRecords"]>>,
  from: string,
  to: string,
  extra: Record<string, unknown> = {},
) {
  return (await f.webhookFixture("transition", {
    owner: f.owner,
    agent: records.agent,
    conversation: records.conversation,
    from,
    to,
    ...extra,
  })) as { run: string; changed: boolean; event: number };
}
function payloads(f: Fixture, id: string) {
  return (
    f.db
      .prepare(
        "SELECT payload FROM webhook_deliveries WHERE subscription_id=? AND kind='run.stopped' ORDER BY rowid",
      )
      .all(id) as { payload: string }[]
  ).map((row) => WebhookStop.parse(JSON.parse(row.payload)));
}

{
  it(`companion manages signed webhook activation, requests and owner isolation through HTTP`, async () => {
    const { f, sink, destination } = await fixture();
    const created = await create(f, destination),
      id = created.subscription.id;
    expect(created.subscription.state).toBe("active");
    expect(created.secret).toBe(created.request.secret);
    expect(sink.received).toHaveLength(1);
    const ping = sink.received[0],
      body = WebhookPayload.parse(JSON.parse(ping.body));
    expect("type" in body && body.type).toBe("ping");
    const timestamp = String(ping.req.headers["x-loop-timestamp"]);
    expect(ping.req.headers["x-loop-signature"]).toBe(
      "v1=" +
        createHmac("sha256", created.secret)
          .update(timestamp + "." + ping.body)
          .digest("hex"),
    );
    expect(ping.req.headers["x-loop-event"]).toBe("control");
    expect(ping.req.headers["x-loop-delivery"]).toBe(body.id);
    expect((await createReplay(f, created.request)).subscription.id).toBe(id);
    expect(sink.received).toHaveLength(1);
    const visible = await list(f);
    expect(visible.policy).toEqual({
      installation: "companion",
      local_receivers: true,
    });
    expect(JSON.stringify(visible)).not.toContain(created.secret);
    expect(JSON.stringify(visible)).not.toContain("secret_sealed");
    expect(
      f.db
        .prepare("SELECT secret_sealed FROM webhook_subscriptions WHERE id=?")
        .get(id),
    ).not.toEqual({ secret_sealed: created.secret });
    const updateId = randomUUID();
    const update = () =>
      f.request(`/api/webhooks/${id}`, {
        headers: f.browser,
        method: "PATCH",
        body: { request_id: updateId, kinds: [] },
      });
    expect((await update()).status).toBe(200);
    expect((await update()).status).toBe(200);
    const testId = randomUUID();
    expect((await action(f, id, "test", testId)).status).toBe(200);
    expect((await action(f, id, "test", testId)).status).toBe(200);
    expect(sink.received).toHaveLength(2);
    expect((await action(f, id, "revoke", testId)).status).toBe(409);
    const token = await f.request("/api/card-tokens", {
      headers: f.browser,
      body: integrationTokenRequest("Webhook refusal", [
        "read",
        "write",
        "approvals:decide",
      ]),
    });
    const secret = (await token.json()).secret;
    for (const path of ["/api/webhooks", `/api/webhooks/${id}/deliveries`]) {
      for (const method of ["GET", "HEAD"])
        expect(
          (
            await f.request(path, {
              method,
              headers: { authorization: "Bearer " + secret },
            })
          ).status,
        ).toBe(403);
    }
    expect(
      (
        await f.request(`/api/webhooks/${id}/test`, {
          headers: { authorization: "Bearer " + secret },
          body: { request_id: randomUUID() },
        })
      ).status,
    ).toBe(403);
    const foreign = randomUUID();
    f.db
      .prepare(
        "INSERT INTO webhook_subscriptions(id,owner_id,url,secret_sealed,creation_digest,kinds,local,state,created_at) SELECT ?,?,url,secret_sealed,creation_digest,kinds,local,state,created_at FROM webhook_subscriptions WHERE id=?",
      )
      .run(foreign, randomUUID(), id);
    expect((await list(f)).subscriptions.map((row) => row.id)).not.toContain(
      foreign,
    );
    for (const name of ["retry", "revoke", "test"] as const)
      expect((await action(f, foreign, name)).status).toBe(404);
    expect(
      (
        await f.request(`/api/webhooks/${foreign}/deliveries`, {
          headers: f.browser,
        })
      ).status,
    ).toBe(404);
    const revoke = randomUUID();
    expect((await action(f, id, "revoke", revoke)).status).toBe(200);
    expect((await action(f, id, "revoke", revoke)).status).toBe(200);
    expect(
      (await list(f)).subscriptions.find((row) => row.id === id)?.state,
    ).toBe("revoked");
    expect(
      (await history(f, id)).every((row) => row.outcome === "accepted"),
    ).toBe(true);
  }, 60000);

  it(`companion commits each stop with the outbox, deduplicates projections and retains later stops`, async () => {
    const { f, sink, destination } = await fixture(),
      records = await f.integrationRecords();
    const { subscription, secret } = await create(f, destination);
    const cases = [
      ["running", "completed", "finished"],
      ["running", "failed", "failed"],
      ["queued", "cancelled", "cancelled"],
      ["running", "interrupted", "interrupted"],
      ["queued", "paused", "paused"],
      ["pausing", "paused", "paused"],
      ["running", "awaiting_approval", "needs_input"],
    ];
    for (const [from, to, reason] of cases) {
      const result = await stop(f, records, from, to);
      expect(result.changed).toBe(true);
      await f.webhookFixture("reproject", { event: result.event });
      const rows = payloads(f, subscription.id).filter(
        (row) => row.run_id === result.run,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].event_id).toBe(result.event);
      expect(rows[0].reason).toBe(reason);
      expect(rows[0].needs).toBeUndefined();
      expect(rows[0].result_preview).toHaveLength(180);
      expect(rows[0].result_preview).toMatch(/^Plain result/);
      if (to === "paused") {
        await stop(f, records, "paused", "queued", { run: result.run });
        await stop(f, records, "running", "completed", { run: result.run });
        expect(
          payloads(f, subscription.id).filter(
            (row) => row.run_id === result.run,
          ),
        ).toHaveLength(2);
      }
    }
    for (const needs of ["approval", "answer"]) {
      const result = await stop(f, records, "running", "awaiting_approval", {
        needs,
      });
      expect(
        payloads(f, subscription.id).find((row) => row.run_id === result.run)
          ?.needs?.kind,
      ).toBe(needs);
    }
    const before = payloads(f, subscription.id).length;
    await stop(f, records, "running", "failed", { rollback: true });
    expect(payloads(f, subscription.id)).toHaveLength(before);
    await f.webhookFixture("deliver");
    for (const received of sink.received) {
      expect(received.req.headers["x-loop-signature"]).toBe(
        "v1=" +
          createHmac("sha256", secret)
            .update(
              received.req.headers["x-loop-timestamp"] + "." + received.body,
            )
            .digest("hex"),
      );
      expect(
        WebhookPayload.safeParse({
          ...JSON.parse(received.body),
          owner_id: f.owner,
        }).success,
      ).toBe(false);
      expect(
        WebhookPayload.safeParse({
          ...JSON.parse(received.body),
          secret_sealed: "secret",
        }).success,
      ).toBe(false);
      expect(received.body).not.toContain("never-in-a-webhook");
    }
  }, 60000);
}
async function createReplay(
  f: Fixture,
  request: ReturnType<typeof webhookRequest>,
) {
  const response = await f.request("/api/webhooks", {
    headers: f.browser,
    body: request,
  });
  expect(response.status).toBe(201);
  return WebhookCreated.parse(await response.json());
}

{
  it(`companion worker maintenance sends webhooks and shuts down an uncertain attempt`, async () => {
    const { f, sink, destination } = await fixture(),
      records = await f.integrationRecords();
    const created = await create(f, destination);
    await stop(f, records, "running", "completed");
    sink.hold(true);
    await f.webhookFixture("start-worker");
    try {
      await expect.poll(() => sink.received.length, { timeout: 8000 }).toBe(2);
    } finally {
      await f.webhookFixture("stop-worker");
    }
    const event = (await history(f, created.subscription.id)).find(
      (row) => row.kind === "run.stopped",
    )!;
    expect(event.outcome).toBe("uncertain");
    expect(event.in_flight).toBe(false);
    expect(event.attempts).toBe(1);
  }, 30000);
}

it("keeps timed-out activation pending and retries the same identity after restart", async () => {
  const { f, sink, destination } = await fixture();
  sink.hold(true);
  const created = await create(f, destination),
    id = created.subscription.id;
  expect(created.subscription.state).toBe("pending_activation");
  expect(created.subscription.activation?.outcome).toBe("uncertain");
  expect(sink.received).toHaveLength(1);
  const first = JSON.parse(sink.received[0].body).id;
  await createReplay(f, created.request);
  expect(sink.received).toHaveLength(1);
  const records = await f.integrationRecords();
  await stop(f, records, "running", "completed");
  expect(payloads(f, id)).toHaveLength(0);
  await f.restart();
  sink.hold(false);
  due(f, id);
  await f.webhookFixture("deliver");
  expect((await list(f)).subscriptions[0].state).toBe("active");
  expect(JSON.parse(sink.received[1].body).id).toBe(first);
}, 60000);

{
  it(`companion preserves attempts when worker shutdown cancels DNS before dispatch`, async () => {
    const sink = await receiver();
    const f = await cardsFixture(false, { webhookReceiver: sink.url });
    const records = await f.integrationRecords();
    const destination = "https://webhook.fixture.test/receiver";
    const active = await create(f, destination);
    await stop(f, records, "running", "completed");
    const [event] = payloads(f, active.subscription.id);
    sink.status(503);
    const pending = await create(f, destination);
    const ping = pending.subscription.activation!.id;
    expect(pending.subscription.state).toBe("pending_activation");
    expect(sink.received).toHaveLength(2);
    for (let interruption = 0; interruption < 6; interruption++) {
      due(f, active.subscription.id);
      due(f, pending.subscription.id);
      await f.webhookNetwork(["93.184.215.14"], 0);
      await f.webhookFixture("start-worker");
      try {
        await expect
          .poll(
            () =>
              f.db
                .prepare(
                  "SELECT count(*) n FROM webhook_deliveries WHERE delivered_at IS NULL AND leased_until IS NOT NULL",
                )
                .get(),
            { timeout: 8000 },
          )
          .toEqual({ n: 2 });
      } finally {
        await f.webhookFixture("stop-worker");
      }
      const eventRow = (await history(f, active.subscription.id)).find(
        (row) => row.id === event.id,
      )!;
      const pingRow = (await history(f, pending.subscription.id)).find(
        (row) => row.id === ping,
      )!;
      expect(eventRow.attempts).toBe(0);
      expect(pingRow.attempts).toBe(1);
      for (const row of [eventRow, pingRow]) {
        expect(row.in_flight).toBe(false);
        expect(row.exhausted).toBe(false);
      }
      expect(
        (await list(f)).subscriptions.find(
          (row) => row.id === active.subscription.id,
        )?.state,
      ).toBe("active");
      expect(
        (await list(f)).subscriptions.find(
          (row) => row.id === pending.subscription.id,
        )?.state,
      ).toBe("pending_activation");
      expect(sink.received).toHaveLength(2);
    }
    await f.webhookNetwork(["93.184.215.14"]);
    sink.status(204);
    await f.webhookFixture("deliver");
    expect(sink.received).toHaveLength(4);
    expect(
      sink.received
        .slice(2)
        .map((row) => JSON.parse(row.body).id)
        .sort(),
    ).toEqual([event.id, ping].sort());
    expect(
      (await list(f)).subscriptions.every((row) => row.state === "active"),
    ).toBe(true);
  }, 60000);
}

it("clears unrelated HTTP status when crash recovery exhausts an unconfirmed final attempt", async () => {
  const { f, sink, destination } = await fixture("public");
  const records = await f.integrationRecords();
  const created = await create(f, destination);
  await stop(f, records, "running", "completed");
  await stop(f, records, "queued", "cancelled");
  const [first, second] = payloads(f, created.subscription.id);
  f.db
    .prepare(
      "UPDATE webhook_deliveries SET attempts=5,last_status=503,last_error='Receiver returned HTTP 503',outcome='rejected' WHERE id=?",
    )
    .run(first.id);
  sink.hold(true);
  await f.webhookFixture("start-worker");
  await expect.poll(() => sink.received.length, { timeout: 8000 }).toBe(3);
  sink.received
    .find((row) => row.req.headers["x-loop-delivery"] === second.id)!
    .res.writeHead(204)
    .end();
  await expect
    .poll(
      async () =>
        (await history(f, created.subscription.id)).find(
          (row) => row.id === second.id,
        )?.outcome,
    )
    .toBe("accepted");
  expect((await list(f)).subscriptions[0].last_status).toBe(204);
  // The production worker is killed while the final attempt is still at the
  // receiver. No callback can establish that attempt's outcome afterward.
  await f.restart();
  f.db
    .prepare("UPDATE webhook_deliveries SET leased_until=0 WHERE id=?")
    .run(first.id);
  expect(await f.webhookFixture("claim")).toEqual([]);
  const failed = (await list(f)).subscriptions[0];
  expect(failed.state).toBe("failed");
  expect(failed.last_status).toBeNull();
  expect(failed.last_attempts).toBe(6);
  expect(failed.last_error).toContain("uncertain");
  const exhausted = (await history(f, created.subscription.id)).find(
    (row) => row.id === first.id,
  )!;
  expect(exhausted.outcome).toBe("uncertain");
  expect(exhausted.last_status).toBeNull();
  expect(exhausted.in_flight).toBe(false);
  expect(exhausted.exhausted).toBe(true);
  expect(sink.received).toHaveLength(3);
}, 30000);

it("keeps credentials and unrelated query data out of the public conversation link", async () => {
  const { f, destination } = await fixture(),
    records = await f.integrationRecords();
  const created = await create(f, destination);
  await stop(f, records, "running", "completed", {
    publicUrl:
      "https://name:never-export@loop.example/old?secret=never-export#private",
  });
  const [event] = payloads(f, created.subscription.id);
  expect(event.url).toBe(
    "https://loop.example/?conversation=" +
      encodeURIComponent(records.conversation),
  );
  expect(JSON.stringify(event)).not.toContain("never-export");
}, 30000);

it("recovers creation after persistence but before its first ping can be sent", async () => {
  const { f, sink, destination } = await fixture("public");
  // Creation's policy lookup succeeds; the attempt's fresh lookup stalls.
  await f.webhookNetwork(["93.184.215.14"], 1);
  const request = webhookRequest(destination, ["run.stopped"]);
  const pending = f
    .request("/api/webhooks", { headers: f.browser, body: request })
    .catch(() => null);
  await expect
    .poll(() =>
      f.db
        .prepare(
          "SELECT count(*) n FROM webhook_deliveries WHERE subscription_id=?",
        )
        .get(request.request_id),
    )
    .toEqual({ n: 1 });
  const before = (await history(f, request.request_id))[0];
  expect(before.attempts).toBe(0);
  expect(before.in_flight).toBe(true);
  expect(sink.received).toHaveLength(0);
  await f.restart();
  await pending;
  const replay = await createReplay(f, request);
  expect(replay.subscription.activation?.id).toBe(before.id);
  expect(replay.subscription.state).toBe("pending_activation");
  f.db
    .prepare("UPDATE webhook_deliveries SET leased_until=0 WHERE id=?")
    .run(before.id);
  await f.webhookFixture("deliver");
  expect(sink.received).toHaveLength(1);
  expect(sink.received[0].req.headers["x-loop-delivery"]).toBe(before.id);
  expect((await list(f)).subscriptions[0].state).toBe("active");
}, 60000);

it("retries an uncertain event with the same body so the receiver can deduplicate", async () => {
  const { f, sink, destination } = await fixture();
  const records = await f.integrationRecords(),
    created = await create(f, destination);
  await stop(f, records, "running", "completed");
  sink.hold(true);
  await f.webhookFixture("deliver");
  const [event] = payloads(f, created.subscription.id);
  expect(sink.effects).toEqual([event.id]);
  expect(
    (await history(f, created.subscription.id)).find(
      (row) => row.id === event.id,
    )?.outcome,
  ).toBe("uncertain");
  sink.hold(false);
  due(f, created.subscription.id);
  await f.webhookFixture("deliver");
  expect(sink.received[2].body).toBe(sink.received[1].body);
  expect(sink.effects).toEqual([event.id]);
}, 60000);

it("keeps an unconfirmed revoked ping uncertain even after explicit rearming", async () => {
  const { f, sink, destination } = await fixture();
  sink.hold(true);
  const created = await create(f, destination);
  await action(f, created.subscription.id, "retry");
  await action(f, created.subscription.id, "revoke");
  const [row] = await history(f, created.subscription.id);
  expect(row.outcome).toBe("uncertain");
  expect(row.exhausted).toBe(true);
  await f.webhookFixture("deliver");
  expect(sink.received).toHaveLength(1);
}, 60000);

it("records the native supervisor's interrupted recovery transition", async () => {
  const { f, destination } = await fixture(),
    records = await f.integrationRecords();
  const created = await create(f, destination);
  f.db.prepare("UPDATE runs SET state='running' WHERE id=?").run(records.run);
  f.db
    .prepare(
      "UPDATE connections SET metadata=json_set(metadata,'$.loopHarness','codex') WHERE id=?",
    )
    .run(records.connection);
  await f.webhookFixture("recover-native");
  const events = payloads(f, created.subscription.id);
  expect(
    events.some(
      (event) => event.run_id === records.run && event.reason === "interrupted",
    ),
  ).toBe(true);
}, 30000);

it("does not activate a revoked in-flight ping and retains the observed response", async () => {
  const { f, sink, destination } = await fixture();
  sink.hold(true);
  const request = webhookRequest(destination, ["run.stopped"]);
  const pending = f.request("/api/webhooks", {
    headers: f.browser,
    body: request,
  });
  await expect.poll(() => sink.received.length).toBe(1);
  expect((await action(f, request.request_id, "revoke")).status).toBe(200);
  sink.received[0].res.writeHead(202).end();
  expect(
    WebhookCreated.parse(await (await pending).json()).subscription.state,
  ).toBe("revoked");
  const [entry] = await history(f, request.request_id);
  expect(entry.outcome).toBe("accepted");
  expect(entry.last_status).toBe(202);
  expect(entry.delivered_at).not.toBeNull();
  due(f, request.request_id);
  await f.webhookFixture("deliver");
  expect(sink.received).toHaveLength(1);
}, 30000);

it("fences a late activation response after its abandoned final claim is exhausted", async () => {
  const { f, sink, destination } = await fixture();
  sink.hold(true);
  const request = webhookRequest(destination, ["run.stopped"]);
  const pending = f.request("/api/webhooks", {
    headers: f.browser,
    body: request,
  });
  await expect.poll(() => sink.received.length).toBe(1);
  // Model a worker whose last dispatch outlived its lease; the replacement
  // must retire its lease identity even though no seventh attempt is allowed.
  f.db
    .prepare(
      "UPDATE webhook_deliveries SET attempts=6,leased_until=0 WHERE subscription_id=?",
    )
    .run(request.request_id);
  expect(await f.webhookFixture("claim")).toEqual([]);
  sink.received[0].res.writeHead(204).end();
  expect(
    WebhookCreated.parse(await (await pending).json()).subscription.state,
  ).toBe("pending_activation");
  const [row] = await history(f, request.request_id);
  expect(row.exhausted).toBe(true);
  expect(row.outcome).toBe("uncertain");
  expect(row.in_flight).toBe(false);
  expect(row.delivered_at).toBeNull();
}, 30000);

it("dead-letters on the sixth failure and retains new stops until an explicit retry", async () => {
  const { f, sink, destination } = await fixture(),
    records = await f.integrationRecords();
  const { subscription } = await create(f, destination);
  sink.status(503);
  const stopped = await stop(f, records, "running", "completed");
  const expected = [30000, 60000, 300000, 900000, 3600000];
  for (let attempt = 1; attempt <= 6; attempt++) {
    due(f, subscription.id);
    const before = Date.now();
    await f.webhookFixture("deliver");
    const row = (await history(f, subscription.id)).find(
      (row) => row.event_id === stopped.event,
    )!;
    expect(row.attempts).toBe(attempt);
    if (attempt <= 5)
      expect(row.available_at - before).toBeGreaterThanOrEqual(
        expected[attempt - 1],
      );
  }
  const failed = (await list(f)).subscriptions[0];
  expect(failed.state).toBe("failed");
  expect(failed.last_attempts).toBe(6);
  sink.status(204);
  const tested = await action(f, subscription.id, "test");
  expect(tested.status).toBe(200);
  expect((await tested.json()).delivery.outcome).toBe("accepted");
  const stillFailed = (await list(f)).subscriptions[0];
  expect(stillFailed.state).toBe("failed");
  expect(stillFailed.last_error).toBe(failed.last_error);
  expect(stillFailed.last_status).toBe(503);
  expect(stillFailed.last_attempts).toBe(6);
  sink.status(503);
  const sent = sink.received.length;
  await stop(f, records, "queued", "cancelled");
  await f.webhookFixture("deliver");
  expect(sink.received).toHaveLength(sent);
  expect(payloads(f, subscription.id)).toHaveLength(2);
  sink.status(200);
  expect((await action(f, subscription.id, "retry")).status).toBe(200);
  await f.webhookFixture("deliver");
  expect(
    (await history(f, subscription.id)).every(
      (row) => row.delivered_at !== null,
    ),
  ).toBe(true);
  const ids = sink.received
    .slice(1)
    .map((row) => row.req.headers["x-loop-delivery"]);
  expect(new Set(ids.slice(0, 6)).size).toBe(1);
  expect(ids.slice(6)).toContain(ids[0]);
}, 60000);

it("rearms an exhausted activation without activating until its same-id ping succeeds", async () => {
  const { f, sink, destination } = await fixture();
  sink.status(503);
  const { subscription } = await create(f, destination);
  for (let i = 1; i < 6; i++) {
    due(f, subscription.id);
    await f.webhookFixture("deliver");
  }
  let row = (await list(f)).subscriptions[0];
  expect(row.state).toBe("pending_activation");
  expect(row.activation?.attempts).toBe(6);
  expect(row.activation?.exhausted).toBe(true);
  const original = row.activation!.id;
  const response = await action(f, row.id, "retry");
  row = WebhookSubscription.parse(await response.json());
  expect(row.state).toBe("pending_activation");
  expect(row.activation?.id).toBe(original);
  expect(row.activation?.attempts).toBe(0);
  sink.status(204);
  await f.webhookFixture("deliver");
  expect((await list(f)).subscriptions[0].state).toBe("active");
  expect(
    new Set(sink.received.map((entry) => entry.req.headers["x-loop-delivery"])),
  ).toEqual(new Set([original]));
}, 60000);

it.each([204, 400])(
  "retains first exhausted event diagnostics when a concurrent event returns %s",
  async (status) => {
    const { f, sink, destination } = await fixture(),
      records = await f.integrationRecords();
    const created = await create(f, destination);
    await stop(f, records, "running", "completed");
    await stop(f, records, "queued", "cancelled");
    const [first, second] = payloads(f, created.subscription.id);
    f.db
      .prepare("UPDATE webhook_deliveries SET attempts=5 WHERE id IN (?,?)")
      .run(first.id, second.id);
    sink.hold(true);
    const sending = f.webhookFixture("deliver");
    await expect.poll(() => sink.received.length).toBe(3);
    sink.received
      .find((row) => row.req.headers["x-loop-delivery"] === first.id)!
      .res.writeHead(503)
      .end();
    await expect
      .poll(async () => (await list(f)).subscriptions[0].state)
      .toBe("failed");
    const firstFailure = (await list(f)).subscriptions[0];
    sink.received
      .find((row) => row.req.headers["x-loop-delivery"] === second.id)!
      .res.writeHead(status)
      .end();
    await sending;
    const failed = (await list(f)).subscriptions[0];
    expect(failed.state).toBe("failed");
    expect(failed.last_attempts).toBe(6);
    expect(failed.last_status).toBe(503);
    expect(failed.last_error).toBe("Receiver returned HTTP 503");
    expect(failed.failed_at).toBe(firstFailure.failed_at);
    expect(
      (await history(f, created.subscription.id)).find(
        (row) => row.id === second.id,
      )?.outcome,
    ).toBe(status === 204 ? "accepted" : "rejected");
  },
  30000,
);

it("reclaims a killed worker's lease with the same identity and cancels queued controls on revoke", async () => {
  const { f, sink, destination } = await fixture(),
    records = await f.integrationRecords();
  const { subscription } = await create(f, destination);
  await stop(f, records, "running", "completed");
  const [claim] = (await f.webhookFixture("claim")) as {
    id: string;
    lease: string;
  }[];
  expect(await f.webhookFixture("claim")).toEqual([]);
  expect(sink.received).toHaveLength(1);
  await f.restart();
  f.db
    .prepare("UPDATE webhook_deliveries SET leased_until=0 WHERE id=?")
    .run(claim.id);
  await f.webhookFixture("deliver");
  expect(sink.received[1].req.headers["x-loop-delivery"]).toBe(claim.id);
  sink.status(503);
  const test = await action(f, subscription.id, "test");
  expect(test.status).toBe(200);
  const sent = sink.received.length;
  await action(f, subscription.id, "revoke");
  due(f, subscription.id);
  await f.webhookFixture("deliver");
  expect(sink.received).toHaveLength(sent);
}, 60000);

{
  it(`companion enforces public IPv6 allocation and all resolved addresses at the HTTP boundary`, async () => {
    const sink = await receiver();
    const f = await cardsFixture(false, { webhookReceiver: sink.url });
    const destination = "https://webhook.fixture.test/receiver";
    for (const addresses of [
      ["::7f00:1"],
      ["64:ff9b:1::7f00:1"],
      ["4000::1"],
      ["2606:4700:4700::1111", "::7f00:1"],
    ]) {
      await f.webhookNetwork(addresses);
      const response = await f.request("/api/webhooks", {
        headers: f.browser,
        body: webhookRequest(destination, ["run.stopped"]),
      });
      expect(response.status, addresses.join(", ")).toBe(400);
      expect((await list(f)).subscriptions).toEqual([]);
      expect(sink.received).toHaveLength(0);
    }
    await f.webhookNetwork(["2606:4700:4700::1111"]);
    const created = await create(f, destination);
    expect(created.subscription.state).toBe("active");
    expect(sink.received).toHaveLength(1);
    // The same resolver/policy must stop a later send if DNS moves to a
    // reserved address; no fixture transport is invoked for that address.
    const records = await f.integrationRecords();
    await stop(f, records, "running", "completed");
    await f.webhookNetwork(["::7f00:1"]);
    await f.webhookFixture("deliver");
    expect(sink.received).toHaveLength(1);
    expect(
      (await history(f, created.subscription.id)).some(
        (row) => row.outcome === "blocked",
      ),
    ).toBe(true);
    expect((await action(f, created.subscription.id, "retry")).status).toBe(
      400,
    );
  }, 30000);
}

it("refuses unsafe destinations and never follows a receiver redirect", async () => {
  {
    const { f, sink, destination } = await fixture();
    const denied = [
      "http://user:password@127.0.0.1/",
      "https://169.254.169.254/",
      "http://[fe80::1]/",
      "https://[::ffff:169.254.1.1]/",
      "https://0.0.0.0/",
      "https://224.0.0.1/",
      "http://93.184.215.14/",
    ];
    for (const url of denied) {
      const response = await f.request("/api/webhooks", {
        headers: f.browser,
        body: webhookRequest(url, ["run.stopped"]),
      });
      expect(response.status, url).toBe(400);
    }
    sink.status(302);
    const created = await create(f, destination);
    expect(created.subscription.state).toBe("pending_activation");
    expect(created.subscription.activation?.last_status).toBe(302);
    expect(sink.received.map((row) => row.req.url)).toEqual(["/receiver"]);
    await f.close();
  }
}, 60000);

it("verifies real deliveries with the documented snippet and rejects tampering", async () => {
  const source = await readFile(
    new URL("../docs/cards-api.md", import.meta.url),
    "utf8",
  );
  const snippet = source.match(
    /```js\n(\/\/ webhook-verification[\s\S]*?)```/,
  )![1];
  const { verifyWebhook } = await import(
    "data:text/javascript;base64," + Buffer.from(snippet).toString("base64")
  );
  const { f, sink, destination } = await fixture();
  const created = await create(f, destination),
    ping = sink.received[0];
  expect(
    verifyWebhook(created.secret, Buffer.from(ping.body), ping.req.headers)
      .type,
  ).toBe("ping");
  expect(() =>
    verifyWebhook(created.secret, ping.body + " ", ping.req.headers),
  ).toThrow();
  expect(() =>
    verifyWebhook(created.secret, ping.body, {
      ...ping.req.headers,
      "x-loop-timestamp": String(
        Number(ping.req.headers["x-loop-timestamp"]) + 1,
      ),
    }),
  ).toThrow();
  expect(() =>
    verifyWebhook(created.secret, ping.body, {
      ...ping.req.headers,
      "x-loop-delivery": randomUUID(),
    }),
  ).toThrow();
  expect(() =>
    verifyWebhook(
      created.secret,
      ping.body,
      ping.req.headers,
      Date.now() + 301000,
    ),
  ).toThrow();
}, 30000);

it("accepts and replays a creation whose secret was issued under the Loop55 name", async () => {
  const { f, destination } = await fixture("public");
  const request = webhookRequest(destination, ["run.stopped"]);
  request.secret = request.secret.replace(/^loop_/, "loop55_");
  const response = await f.request("/api/webhooks", {
    headers: f.browser,
    body: request,
  });
  expect(response.status, await response.clone().text()).toBe(201);
  const created = WebhookCreated.parse(await response.json());
  // A retry of the same request finds the original subscription.
  const replay = await createReplay(f, request);
  expect(replay.subscription.id).toBe(created.subscription.id);
}, 30000);
