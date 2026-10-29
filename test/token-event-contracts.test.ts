import { expect, it, onTestFinished } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { WebSocket } from "ws";
import { cardsFixture } from "./helpers/cards-fixture";
import {
  integrationTokenRequest,
  cardTokenRequest,
} from "../src/shared/card-access";
import { workspaceApi } from "../src/shared/workspace-api";
import { WorkspaceFrameV3 } from "../src/shared/workspace-events";

type Fixture = Awaited<ReturnType<typeof cardsFixture>>;
type Frame = { raw: string; frame: WorkspaceFrameV3 };
async function token(
  f: Fixture,
  scopes: ("read" | "write" | "approvals:decide")[] = ["read"],
) {
  const response = await f.request("/api/card-tokens", {
    headers: f.browser,
    body: integrationTokenRequest("Event reader", scopes),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { secret: string; token: { id: string } };
}
function checkpoint(f: Fixture, id: string) {
  return f.db
    .prepare(
      "SELECT epoch,cursor,connection_id FROM token_event_cursors WHERE token_id=?",
    )
    .get(id) as
    { epoch: string | null; cursor: number; connection_id: string } | undefined;
}
async function connect(f: Fixture, secret: string, query = "") {
  const frames: Frame[] = [];
  let ended = false;
  const socket = new WebSocket(
    f.transportOrigin.replace("http:", "ws:") + "/api/events/stream" + query,
    {
      headers: {
        host: new URL(f.browser.origin).host,
        authorization: "Bearer " + secret,
      },
    },
  );
  onTestFinished(() => socket.terminate());
  socket.on("message", (data, binary) => {
    expect(binary).toBe(false);
    const raw = data.toString();
    frames.push({ raw, frame: WorkspaceFrameV3.parse(JSON.parse(raw)) });
  });
  socket.on("close", () => {
    ended = true;
  });
  socket.on("error", () => {
    ended = true;
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
    socket.once("unexpected-response", (_req, res) => {
      res.resume();
      reject(new Error("Upgrade refused: " + res.statusCode));
    });
  });
  return {
    socket,
    frames,
    get closed() {
      return ended;
    },
    close: () => socket.terminate(),
    pause: () => socket.pause(),
    resume: () => socket.resume(),
  };
}
type Stream = Awaited<ReturnType<typeof connect>>;
async function frame(
  stream: Stream,
  predicate: (f: WorkspaceFrameV3) => boolean = () => true,
) {
  await expect
    .poll(() => stream.frames.find((value) => predicate(value.frame)), {
      timeout: 7000,
    })
    .toBeDefined();
  return stream.frames.find((value) => predicate(value.frame))!;
}
function ack(stream: Stream, value: WorkspaceFrameV3) {
  if (stream.socket.readyState !== WebSocket.OPEN)
    return Promise.resolve(false);
  // A control ping after the acknowledgement establishes that its synchronous
  // handler completed. The production protocol has no acknowledgement receipt.
  return new Promise<boolean>((resolve, reject) => {
    const nonce = randomUUID();
    const done = (accepted: boolean) => {
      clearTimeout(timer);
      stream.socket.off("close", closed);
      stream.socket.off("pong", pong);
      resolve(accepted);
    };
    const closed = () => done(false);
    const pong = (data: Buffer) => {
      if (data.toString() === nonce) done(true);
    };
    const timer = setTimeout(() => {
      stream.socket.off("close", closed);
      stream.socket.off("pong", pong);
      reject(new Error("No acknowledgement barrier"));
    }, 4000);
    stream.socket.once("close", closed);
    stream.socket.on("pong", pong);
    stream.socket.send(
      JSON.stringify({
        type: "ack",
        epoch: value.epoch,
        cursor: value.cursor,
      }),
    );
    stream.socket.ping(nonce);
  });
}

async function refusedUpgrade(
  f: Fixture,
  headers: Record<string, string>,
  path = "/api/events/stream",
) {
  const socket = new WebSocket(
    f.transportOrigin.replace("http:", "ws:") + path,
    { headers: { host: new URL(f.browser.origin).host, ...headers } },
  );
  onTestFinished(() => socket.terminate());
  socket.on("error", () => {});
  return new Promise<number>((resolve, reject) => {
    socket.once("open", () =>
      reject(new Error("Unexpected authorized socket")),
    );
    socket.once("unexpected-response", (req, response) => {
      const status = response.statusCode!;
      response.resume();
      req.destroy();
      resolve(status);
    });
    socket.once("error", reject);
  });
}
async function browserFrame(f: Fixture, epoch: string, cursor: number) {
  const socket = new WebSocket(
    f.transportOrigin.replace("http:", "ws:") +
      `/api/events/ws?v=3&projection=1&epoch=${epoch}&cursor=${cursor}`,
    { headers: f.browser },
  );
  onTestFinished(() => socket.terminate());
  const frames: string[] = [];
  socket.on("error", () => {});
  socket.on("message", (data) => frames.push(data.toString()));
  await expect.poll(() => frames.length, { timeout: 7000 }).toBeGreaterThan(0);
  socket.close();
  return frames[0];
}

for (const mode of ["server", "companion", "multi-user"] as const) {
  it(`${mode} admits only read sockets and confirms connection-bound replay`, async () => {
    const f = await cardsFixture(mode, false, {
      projectedWrites: true,
      relay: mode === "companion",
    });
    const local = await f.integrationRecords(),
      foreign = await f.integrationRecords(randomUUID());
    const reader = await token(f),
      other = await token(f);
    const headers = { authorization: "Bearer " + reader.secret };
    f.db.exec("ALTER TABLE events ADD COLUMN fixture_secret TEXT");
    f.db
      .prepare("UPDATE events SET fixture_secret='private-event-column'")
      .run();
    const browserPage = await (
      await f.request("/api/events?after=0", { headers: f.browser })
    ).json();
    const page = await f.request("/api/events?after=0", { headers });
    const rows = await page.json();
    expect(rows).toEqual(browserPage);
    expect(workspaceApi.events.response.parse(rows)).toEqual(rows);
    expect(JSON.stringify(rows)).not.toContain("private-event-column");
    expect(JSON.stringify(rows)).not.toContain(
      "integration-fixture-credential",
    );
    expect(
      rows.every((row: { owner_id: string }) => row.owner_id === f.owner),
    ).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(foreign.conversation);
    expect(page.headers.get("x-loop-change-cursor")).toBeNull();
    expect(
      (await f.request("/api/events", { headers, method: "HEAD" })).status,
    ).toBe(200);

    const refused = [
      (await token(f, ["write"])).secret,
      (await token(f, ["approvals:decide"])).secret,
    ];
    for (const scope of ["results:read", "cards:read"] as const) {
      const legacy = await f.request("/api/card-tokens", {
        headers: f.browser,
        body: cardTokenRequest("Legacy", scope),
      });
      refused.push((await legacy.json()).secret);
    }
    for (const secret of refused) {
      const deniedHeaders = { ...f.browser, authorization: "Bearer " + secret };
      for (const path of ["/api/events", "/api/events/stream"])
        for (const method of ["GET", "HEAD"])
          expect(
            (await f.request(path, { method, headers: deniedHeaders })).status,
          ).toBe(403);
      expect(await refusedUpgrade(f, deniedHeaders)).toBe(403);
    }
    expect(await refusedUpgrade(f, f.browser)).toBe(401);
    expect(
      await refusedUpgrade(f, {
        ...f.browser,
        authorization: "Bearer invalid",
      }),
    ).toBe(401);
    for (const extra of [
      { origin: "https://foreign.example" },
      { "sec-fetch-site": "cross-site" },
      { "x-http-method-override": "POST" },
    ] as Record<string, string>[])
      expect(await refusedUpgrade(f, { ...headers, ...extra })).toBe(403);
    for (const path of [
      "/api/events/ws",
      "/api/agent-sources/foreign/events/ws",
    ])
      expect([403, 404]).toContain(
        await refusedUpgrade(f, { ...f.browser, ...headers }, path),
      );
    if (mode === "companion")
      expect(await refusedUpgrade(f, { ...f.browser, ...headers }, "/ws")).toBe(
        403,
      );
    for (const query of [
      "?after=-1",
      "?after=0&after=1",
      "?token=" + reader.secret,
    ])
      expect(
        await refusedUpgrade(f, headers, "/api/events/stream" + query),
      ).toBe(400);
    for (const method of ["GET", "HEAD"]) {
      const ordinary = await f.request("/api/events/stream", {
        method,
        headers,
      });
      expect(ordinary.status).toBe(426);
      // Relay strips hop-by-hop response headers at its HTTP boundary.
      if (mode !== "companion")
        expect(ordinary.headers.get("upgrade")).toBe("websocket");
    }
    expect(checkpoint(f, reader.token.id)).toBeUndefined();
    expect(
      (
        await f.request("/api/events/stream/ack?epoch=none&cursor=0", {
          headers,
        })
      ).status,
    ).toBe(403);

    const first = await connect(f, reader.secret),
      reset = (await frame(first)).frame;
    expect(reset.type).toBe("reset");
    expect(checkpoint(f, reader.token.id)).toMatchObject({
      epoch: null,
      cursor: 0,
    });
    const firstConnection = checkpoint(f, reader.token.id)!.connection_id;
    expect(
      (await f.request("/api/events/stream", { headers, method: "HEAD" }))
        .status,
    ).toBe(426);
    expect(checkpoint(f, reader.token.id)!.connection_id).toBe(firstConnection);
    expect(await ack(first, reset)).toBe(true);
    expect(checkpoint(f, reader.token.id)).toMatchObject({
      epoch: reset.epoch,
      cursor: reset.cursor,
    });

    f.db
      .prepare(
        "UPDATE messages SET content='Foreign private change' WHERE id=?",
      )
      .run(foreign.reply);
    f.db
      .prepare(
        "UPDATE messages SET content='Unconfirmed projected answer' WHERE id=?",
      )
      .run(local.reply);
    const offered = (await frame(first, (value) => value.cursor > reset.cursor))
      .frame;
    expect(offered.type).toBe("events");
    expect(JSON.stringify(offered)).toContain("Unconfirmed projected answer");
    expect(JSON.stringify(offered)).not.toContain("Foreign private change");
    expect(JSON.stringify(offered)).not.toContain("fixture_secret");
    expect(checkpoint(f, reader.token.id)?.cursor).toBe(reset.cursor);
    first.close();
    const replay = await connect(f, reader.secret),
      replayed = await frame(replay);
    expect(replayed.frame.type).toBe("events");
    expect(replayed.frame.cursor).toBe(offered.cursor);
    expect(replayed.raw).toBe(await browserFrame(f, reset.epoch, reset.cursor));
    expect(await ack(first, offered)).toBe(false);
    expect(await ack(replay, replayed.frame)).toBe(true);

    const independent = await connect(
      f,
      other.secret,
      "?after=" + reset.cursor,
    );
    const independentFrame = (await frame(independent)).frame;
    expect(independentFrame.cursor).toBe(offered.cursor);
    expect(checkpoint(f, other.token.id)?.cursor).toBe(0);
    expect(checkpoint(f, reader.token.id)?.cursor).toBe(offered.cursor);
    const replacement = await connect(f, reader.secret),
      replacementFrame = (await frame(replacement)).frame;
    await expect.poll(() => replay.closed).toBe(true);
    const replacementId = checkpoint(f, reader.token.id)!.connection_id;
    expect(replacementId).not.toBe(firstConnection);
    expect(await ack(replay, replayed.frame)).toBe(false);
    expect(await ack(replacement, replacementFrame)).toBe(true);
    expect(checkpoint(f, other.token.id)?.cursor).toBe(0);
    const beforeRestart = checkpoint(f, reader.token.id)!;
    await f.restart();
    const restarted = await connect(f, reader.secret),
      resumed = (await frame(restarted)).frame;
    expect(resumed.type).toBe("events");
    expect(resumed.epoch).toBe(beforeRestart.epoch);
    expect(resumed.cursor).toBe(beforeRestart.cursor);
    expect(await ack(restarted, resumed)).toBe(true);
    expect(
      (
        await f.request("/api/card-tokens/" + reader.token.id, {
          method: "DELETE",
          headers: f.browser,
        })
      ).status,
    ).toBe(200);
    await f.eventDelta(local.reply, "Revoked stream must not receive this");
    await expect.poll(() => restarted.closed, { timeout: 7000 }).toBe(true);
    expect(
      restarted.frames.some((value) =>
        value.raw.includes("Revoked stream must not receive this"),
      ),
    ).toBe(false);
    independent.close();
    replacement.close();
  }, 40_000);

  it(`${mode} refuses unoffered, stale and non-acknowledgement client messages`, async () => {
    const f = await cardsFixture(mode, false, { relay: mode === "companion" }),
      reader = await token(f);
    const first = await connect(f, reader.secret),
      reset = (await frame(first)).frame;
    expect(await ack(first, { ...reset, cursor: reset.cursor + 9999 })).toBe(
      false,
    );
    expect(checkpoint(f, reader.token.id)?.cursor).toBe(0);
    for (const message of [
      JSON.stringify({ type: "ack", epoch: "obsolete", cursor: reset.cursor }),
      JSON.stringify({ type: "run", input: "must not dispatch" }),
      "not json",
      Buffer.from(
        JSON.stringify({
          type: "ack",
          epoch: reset.epoch,
          cursor: reset.cursor,
        }),
      ),
      JSON.stringify({
        type: "ack",
        epoch: "x".repeat(2048),
        cursor: reset.cursor,
      }),
    ]) {
      const socket = await connect(f, reader.secret);
      await frame(socket);
      socket.socket.send(message);
      await expect.poll(() => socket.closed, { timeout: 4000 }).toBe(true);
      expect(checkpoint(f, reader.token.id)?.cursor).toBe(0);
    }
  }, 30_000);

  it(`${mode} includes committed deadline payloads only through the read event grant`, async () => {
    const f = await cardsFixture(mode, false, { relay: mode === "companion" }),
      records = await f.integrationRecords(),
      reader = await token(f);
    const expires = Date.now() + 60_000;
    f.db
      .prepare(
        "INSERT INTO pr_watches(id,owner_id,conversation_id,agent_id,repo_owner,repo_name,number,state,created_at,updated_at) VALUES('event-clock-watch',?,?,?,'fixture','repo',1,'stopped',1,?)",
      )
      .run(f.owner, records.conversation, records.agent, expires - 604_800_000);
    const deadline = () =>
      f.db
        .prepare(
          "SELECT id,payload FROM events WHERE owner_id=? AND type='deadline' AND json_extract(payload,'$.nextDeadline')=? ORDER BY id DESC LIMIT 1",
        )
        .get(f.owner, expires) as { id: number; payload: string } | undefined;
    await expect.poll(deadline, { timeout: 7000 }).toBeDefined();
    const row = deadline()!,
      payload = JSON.parse(row.payload),
      after = row.id - 1;
    const headers = { authorization: "Bearer " + reader.secret };
    const page = await f.request(`/api/events?after=${after}`, { headers });
    const browser = await f.request(`/api/events?after=${after}`, {
      headers: f.browser,
    });
    const rows = await page.json();
    expect(rows).toEqual(await browser.json());
    expect(rows[0]).toMatchObject({ id: row.id, payload: row.payload });
    expect(payload).toEqual({
      serverNow: expect.any(Number),
      nextDeadline: expires,
    });
    for (const header of ["x-loop-server-now", "x-loop-next-deadline"])
      expect(page.headers.get(header)).toBeNull();

    const stream = await connect(f, reader.secret, `?after=${after}`),
      offered = await frame(stream);
    expect(offered.frame).toMatchObject({
      type: "events",
      events: expect.arrayContaining([
        {
          id: row.id,
          event: expect.objectContaining({ type: "deadline", ...payload }),
        },
      ]),
    });
    expect(offered.raw).toBe(await browserFrame(f, offered.frame.epoch, after));
    stream.close();
  }, 20_000);
}

for (const mode of ["server", "companion"] as const) {
  it(`${mode} preserves whole oversize HTTP events and uses explicit resets for invalid history`, async () => {
    const f = await cardsFixture(mode, false, { relay: mode === "companion" }),
      records = await f.integrationRecords(),
      reader = await token(f);
    const first = await connect(f, reader.secret),
      initial = (await frame(first)).frame;
    expect(await ack(first, initial)).toBe(true);
    first.close();
    const mediumFirst = await f.eventDelta(records.reply, "x".repeat(300_000));
    const mediumSecond = await f.eventDelta(records.reply, "y".repeat(300_000));
    const mediumPage = await (
      await f.request(`/api/events?after=${mediumFirst - 1}`, {
        headers: { authorization: "Bearer " + reader.secret },
      })
    ).json();
    expect(mediumPage.map((item: { id: number }) => item.id)).toEqual([
      mediumFirst,
    ]);
    const mediumNext = await (
      await f.request(`/api/events?after=${mediumFirst}`, {
        headers: { authorization: "Bearer " + reader.secret },
      })
    ).json();
    expect(mediumNext[0].id).toBe(mediumSecond);
    const large = "界".repeat(180_000);
    const largeId = await f.eventDelta(records.reply, large);
    const nextId = await f.eventDelta(records.reply, "next whole row");
    const headers = { authorization: "Bearer " + reader.secret };
    const largeResponse = await f.request(`/api/events?after=${largeId - 1}`, {
      headers,
    });
    expect(largeResponse.status).toBe(200);
    const row = f.db.prepare("SELECT * FROM events WHERE id=?").get(largeId);
    expect(await largeResponse.json()).toEqual(
      workspaceApi.events.response.parse([row]),
    );
    const next = await (
      await f.request(`/api/events?after=${largeId}`, { headers })
    ).json();
    expect(next[0].id).toBe(nextId);
    const ordinary = await (
      await f.request(`/api/events?after=${largeId - 1}`, {
        headers: f.browser,
      })
    ).json();
    expect(ordinary.map((item: { id: number }) => item.id)).toEqual([
      largeId,
      nextId,
    ]);

    const bounded = await connect(f, reader.secret),
      boundedFrame = (await frame(bounded)).frame;
    expect(boundedFrame.type).toBe("events");
    expect(JSON.stringify(boundedFrame)).not.toContain(large);
    expect(JSON.stringify(boundedFrame)).toContain("invalidate");
    // No acknowledgement: prune past the last confirmed id in this epoch.
    bounded.close();
    f.db
      .prepare("DELETE FROM events WHERE owner_id=? AND id<?")
      .run(f.owner, nextId);
    const pruned = await connect(f, reader.secret),
      prunedReset = (await frame(pruned)).frame;
    expect(prunedReset).toMatchObject({
      type: "reset",
      epoch: initial.epoch,
      cursor: nextId,
    });
    expect(checkpoint(f, reader.token.id)?.cursor).toBe(initial.cursor);
    expect(await ack(pruned, prunedReset)).toBe(true);
    pruned.close();

    const epoch = randomUUID();
    f.db
      .prepare("UPDATE change_watermark SET epoch=? WHERE owner_id=?")
      .run(epoch, f.owner);
    const changed = await connect(f, reader.secret),
      changedReset = (await frame(changed)).frame;
    expect(changedReset).toMatchObject({
      type: "reset",
      epoch,
      cursor: nextId,
    });
    expect(checkpoint(f, reader.token.id)?.epoch).toBe(initial.epoch);
    expect(await ack(changed, changedReset)).toBe(true);
    changed.close();

    // A checkpoint from beyond a restored log must be repairable by confirming
    // its reset, even though the resulting numeric cursor is lower.
    f.db
      .prepare("UPDATE token_event_cursors SET cursor=? WHERE token_id=?")
      .run(nextId + 1, reader.token.id);
    const ahead = await connect(f, reader.secret),
      aheadReset = (await frame(ahead)).frame;
    expect(aheadReset).toMatchObject({ type: "reset", epoch, cursor: nextId });
    expect(checkpoint(f, reader.token.id)?.cursor).toBe(nextId + 1);
    // New commits can overtake the invalid saved cursor while the client is
    // still reconciling the reset. Confirming that reset must still repair it.
    const afterResetFirst = await f.eventDelta(
      records.reply,
      "first after reset",
    );
    const afterResetLast = await f.eventDelta(
      records.reply,
      "second after reset",
    );
    await frame(ahead, (value) => value.cursor === afterResetLast);
    expect(await ack(ahead, aheadReset)).toBe(true);
    expect(checkpoint(f, reader.token.id)?.cursor).toBe(nextId);
    ahead.close();
    const repaired = await connect(f, reader.secret),
      repairedFrame = (await frame(repaired)).frame;
    expect(repairedFrame.type).toBe("events");
    if (repairedFrame.type !== "events")
      throw new Error("Expected replay after reset");
    expect(repairedFrame.events.map((event) => event.id)).toEqual([
      afterResetFirst,
      afterResetLast,
    ]);
    expect(await ack(repaired, repairedFrame)).toBe(true);
    repaired.close();

    const tail = await f.eventDelta(records.reply, "deleted tail");
    f.db.prepare("DELETE FROM events WHERE id=?").run(tail);
    const hole = await connect(f, reader.secret),
      holeReset = (await frame(hole)).frame;
    expect(holeReset).toMatchObject({ type: "reset", epoch, cursor: tail });
    expect(checkpoint(f, reader.token.id)?.cursor).toBe(afterResetLast);
    const newer = await f.eventDelta(records.reply, "newer than reset");
    const newerFrame = (await frame(hole, (value) => value.cursor === newer))
      .frame;
    expect(await ack(hole, newerFrame)).toBe(true);
    expect(await ack(hole, holeReset)).toBe(false);
    expect(checkpoint(f, reader.token.id)?.cursor).toBe(newer);
    hole.close();
  }, 30_000);

  it(`${mode} drains the production listener with an idle token stream`, async () => {
    const f = await cardsFixture(mode, false, { relay: mode === "companion" }),
      reader = await token(f),
      stream = await connect(f, reader.secret);
    await frame(stream);
    const start = performance.now();
    const stopped = f.stopListening();
    await expect.poll(() => stream.closed, { timeout: 2000 }).toBe(true);
    await stopped;
    expect(performance.now() - start).toBeLessThan(2500);
  }, 15_000);

  it(`${mode} releases a non-reading token stream after overflow and drains the listener`, async () => {
    const f = await cardsFixture(mode, false, { relay: mode === "companion" }),
      records = await f.integrationRecords(),
      reader = await token(f);
    const subscribers = await f.eventSubscriberCount();
    const stream = await connect(f, reader.secret);
    await frame(stream);
    expect(await f.tokenSocketCount()).toBe(1);
    expect(await f.eventSubscriberCount()).toBe(subscribers + 1);
    stream.pause();
    const text = "x".repeat(48_000);
    for (let i = 0; i < 512; i++) {
      await f.eventDelta(records.reply, text);
      if (
        (i + 1) % 16 === 0 &&
        (await f.eventSubscriberCount()) === subscribers
      )
        break;
    }
    await expect
      .poll(() => f.eventSubscriberCount(), { timeout: 4000 })
      .toBe(subscribers);
    try {
      // Unsubscribing alone must not leave the response and its buffered bytes
      // alive until the stalled client chooses to resume reading.
      await expect.poll(() => f.tokenSocketCount(), { timeout: 4000 }).toBe(0);
      let drained = false;
      const stopped = f.stopListening().then(() => {
        drained = true;
      });
      await expect.poll(() => drained, { timeout: 4000 }).toBe(true);
      await stopped;
    } finally {
      stream.resume();
    }
  }, 30_000);

  it(`${mode} closes an idle revoked stream within thirty seconds`, async () => {
    const f = await cardsFixture(mode, false, { relay: mode === "companion" }),
      reader = await token(f),
      stream = await connect(f, reader.secret);
    await frame(stream);
    const start = performance.now();
    const revoked = await f.request("/api/card-tokens/" + reader.token.id, {
      method: "DELETE",
      headers: f.browser,
    });
    expect(revoked.status).toBe(200);
    await expect
      .poll(() => stream.closed, { timeout: 29_000, interval: 100 })
      .toBe(true);
    expect(performance.now() - start).toBeLessThan(30_000);
    expect(
      (
        await f.request("/api/events", {
          headers: { authorization: "Bearer " + reader.secret },
        })
      ).status,
    ).toBe(401);
  }, 40_000);
}

it("publishes the token socket and acknowledgement schema with bearer-only security", () => {
  const http = JSON.parse(readFileSync("docs/openapi.json", "utf8"));
  const channels = JSON.parse(
    readFileSync("docs/openapi-channels.json", "utf8"),
  );
  expect(workspaceApi.channels.tokenEvents.frames).toBe(
    workspaceApi.channels.events.frames,
  );
  expect(workspaceApi.channels.tokenEvents.request).toBe(
    workspaceApi.tokenEvents,
  );
  expect(channels["x-channels"].tokenEvents).toMatchObject({
    kind: "socket",
    path: "/api/events/stream",
    security: [{ IntegrationBearer: [] }],
    frames: { $ref: "#/components/schemas/WorkspaceFrameV3" },
    confirmation: { $ref: "#/components/schemas/TokenEventAck" },
  });
  expect(
    workspaceApi.channels.tokenEvents.confirmation.safeParse({
      type: "ack",
      epoch: "e",
      cursor: 1,
    }).success,
  ).toBe(true);
  expect(http.paths["/api/events/stream"].get.security).toEqual([
    { IntegrationBearer: [] },
  ]);
  expect(http.paths["/api/events/stream"].get.responses["426"]).toBeDefined();
  expect(http.paths["/api/events/stream"].get.responses["503"]).toBeDefined();
  expect(http.paths["/api/events/stream/ack"]).toBeUndefined();
  expect(http.paths["/api/events"].get["x-scopes"]).toEqual(["read"]);
});
