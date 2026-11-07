import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createConnection } from "node:net";
import { cardsFixture } from "./helpers/cards-fixture";
import { compiledServerFixture } from "./helpers/compiled-server";
import {
  WorkspaceFrameV3,
  COMPLETE_WORKSPACE_CAPABILITIES,
} from "../src/shared/workspace-events";

let compiled: Awaited<ReturnType<typeof compiledServerFixture>>;
beforeAll(async () => {
  compiled = await compiledServerFixture();
}, 30_000);

const sockets: WebSocket[] = [];
// Servers started inside a test close with that test (see cardsFixture).
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.terminate();
});
afterAll(async () => {
  await compiled?.close();
});
function fixture(projectedWrites = false) {
  return cardsFixture(compiled.source, { projectedWrites });
}
function connect(
  f: Awaited<ReturnType<typeof fixture>>,
  query = "?v=3",
  headers = f.browser,
  path = "/api/events/ws",
) {
  const socket = new WebSocket(
    f.origin.replace("http:", "ws:") + path + query,
    { headers },
  );
  sockets.push(socket);
  const frames: any[] = [];
  socket.on("message", (message) =>
    frames.push(JSON.parse(message.toString())),
  );
  socket.on("error", () => {});
  return { socket, frames };
}
function seed(
  f: Awaited<ReturnType<typeof fixture>>,
  owner = f.owner,
  prefix = "",
) {
  f.db
    .prepare(
      "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,created_at) VALUES(?,?,'Writer',?,'openai','fixture',1)",
    )
    .run(prefix + "agent", owner, prefix + "writer");
  f.db
    .prepare(
      "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,'Socket thread',1)",
    )
    .run(prefix + "thread", owner, prefix + "agent");
  f.db
    .prepare(
      "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,'Prompt','running',?,1,1)",
    )
    .run(
      prefix + "run",
      owner,
      prefix + "agent",
      prefix + "thread",
      prefix + "key",
    );
}
function emit(
  f: Awaited<ReturnType<typeof fixture>>,
  type: string,
  owner = f.owner,
  run = "run",
) {
  return f.db
    .prepare(
      "INSERT INTO events(owner_id,run_id,type,payload,created_at) VALUES(?,?,?,'{}',1)",
    )
    .run(owner, run, type).lastInsertRowid;
}

it("keeps the listener available when rejected upgrade clients reset their sockets", async () => {
  const f = await fixture();
  const url = new URL(f.origin);
  for (let batch = 0; batch < 10; batch++) {
    await Promise.all(
      Array.from(
        { length: 30 },
        (_, index) =>
          new Promise<void>((resolve) => {
            const socket = createConnection({
              host: "127.0.0.1",
              port: Number(url.port),
            });
            socket.on("error", () => resolve());
            socket.on("connect", () => {
              const path = index % 2 ? "/api/events/ws" : "/unknown-upgrade";
              socket.write(
                `GET ${path} HTTP/1.1\r\nHost: ${url.host}\r\nOrigin: https://elsewhere.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
                () =>
                  setTimeout(() => {
                    socket.resetAndDestroy();
                    resolve();
                  }, index % 3),
              );
            });
          }),
      ),
    );
  }
  expect(
    (await f.request("/api/bootstrap", { headers: f.browser })).status,
  ).toBe(200);
  const { frames } = connect(f);
  await expect.poll(() => frames.length).toBe(1);
}, 30_000);

{
  it(`companion rejects malformed upgrade URLs without stopping the listener`, async () => {
    const f = await fixture();
    for (const headers of [{}, f.browser]) {
      const response = await f.request("//[", {
        headers: { ...headers, connection: "Upgrade", upgrade: "websocket" },
      });
      expect([400, 403]).toContain(response.status);
    }
    expect(
      (await f.request("/api/bootstrap", { headers: f.browser })).status,
    ).toBe(200);
    const { frames } = connect(f);
    await expect.poll(() => frames.length).toBe(1);
  }, 30_000);

  it(`companion pushes Working/Done changes, save/dismiss revisions and reconnect catch-up`, async () => {
    const f = await fixture();
    seed(f);
    const { socket, frames } = connect(f);
    await expect.poll(() => frames.length, { timeout: 7000 }).toBe(1);
    expect(frames[0]).toMatchObject({ v: 3, type: "reset" });
    expect(frames[0].cursor).toBeGreaterThan(0);
    const { epoch } = frames[0];
    f.db
      .transaction(() => {
        f.db
          .prepare(
            "UPDATE runs SET state='completed',updated_at=? WHERE id='run'",
          )
          .run(Date.now());
        f.db
          .prepare(
            "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES('answer',?,'thread','run','assistant','A completed answer','{}',?)",
          )
          .run(f.owner, Date.now());
      })
      .immediate();
    await expect
      .poll(() => frames.length, { timeout: 7000 })
      .toBeGreaterThan(1);
    // Source-row producers publish the mutation without a synthetic revision frame.
    expect(frames.at(-1).type).toBe("events");
    expect(frames.at(-1).cursor).toBeGreaterThan(frames[0].cursor);
    expect(frames.at(-1).events.length).toBeGreaterThan(0);
    f.db
      .prepare(
        "INSERT INTO artifacts(id,owner_id,kind,title,content,created_at,updated_at) VALUES('note',?,'markdown','A saved note','Body',1,1)",
      )
      .run(f.owner);
    await expect
      .poll(() => frames.length, { timeout: 7000 })
      .toBeGreaterThan(2);
    let before = frames.length;
    f.db.prepare("UPDATE artifacts SET pinned=1 WHERE id='note'").run();
    await expect
      .poll(() => frames.length, { timeout: 7000 })
      .toBeGreaterThan(before);
    before = frames.length;
    const dismissed = await f.request("/api/feed/thread", {
      method: "PATCH",
      body: { hidden: true, cardKey: "run:run" },
      headers: f.browser,
    });
    expect(dismissed.status).toBe(200);
    await expect
      .poll(() => frames.length, { timeout: 7000 })
      .toBeGreaterThan(before);
    const first = emit(f, "first");
    await expect.poll(() => frames.at(-1)?.cursor).toBe(Number(first));
    socket.close();
    await expect.poll(() => socket.readyState).toBe(WebSocket.CLOSED);
    const second = emit(f, "while-disconnected");
    const replay = connect(f, `?v=3&epoch=${epoch}&cursor=${first}`);
    await expect.poll(() => replay.frames.length).toBeGreaterThan(0);
    expect(replay.frames[0]).toMatchObject({
      type: "events",
      cursor: Number(second),
      events: [{ id: Number(second), event: { type: "invalidate" } }],
    });
    const reset = connect(f, "?v=3&epoch=previous-process&cursor=999999");
    await expect.poll(() => reset.frames.length).toBeGreaterThan(0);
    expect(reset.frames[0]).toMatchObject({
      type: "reset",
      cursor: Number(second),
    });
  }, 40_000);

  it(`companion reconciles oversized event replays without a repeated disconnect`, async () => {
    const f = await fixture();
    seed(f);
    const first = connect(f);
    await expect.poll(() => first.frames.length).toBe(1);
    const { epoch, cursor: baseline } = first.frames[0];
    first.socket.close();
    await expect.poll(() => first.socket.readyState).toBe(WebSocket.CLOSED);
    // Durable results need not fit a transport frame. This batch exceeds the
    // linked gateway's 8 MiB frame limit without any individual giant result.
    const payload = JSON.stringify({ text: "x".repeat(96 * 1024) });
    const insert = f.db.prepare(
      "INSERT INTO events(owner_id,run_id,type,payload,created_at) VALUES(?,'run','progress',?,1)",
    );
    f.db.transaction(() => {
      for (let n = 0; n < 100; n++) insert.run(f.owner, payload);
    })();
    const replay = connect(f, `?v=3&epoch=${epoch}&cursor=${baseline}`);
    await expect.poll(() => replay.frames.length).toBeGreaterThan(0);
    await expect.poll(() => replay.frames.at(-1)?.cursor).toBe(baseline + 100);
    expect(replay.frames.flatMap((frame) => frame.events)).toHaveLength(100);
    expect(
      replay.frames
        .flatMap((frame) => frame.events)
        .every((entry) => entry.event.type === "invalidate"),
    ).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(replay.frames[0]))).toBeLessThan(
      1024 * 1024,
    );
    expect(
      f.db
        .prepare(
          "SELECT payload FROM events WHERE owner_id=? AND type='progress' LIMIT 1",
        )
        .get(f.owner),
    ).toEqual({ payload });
    const next = emit(f, "after-large-replay");
    await expect.poll(() => replay.frames.at(-1)?.cursor).toBe(Number(next));
    expect(replay.frames.at(-1)).toMatchObject({
      type: "events",
      events: [{ id: Number(next), event: { type: "invalidate" } }],
    });
    // Many individually small payloads must also respect the total budget.
    f.db.transaction(() => {
      for (let n = 0; n < 40; n++)
        insert.run(f.owner, JSON.stringify({ text: "x".repeat(48 * 1024) }));
    })();
    await expect.poll(() => replay.frames.at(-1)?.cursor).toBe(baseline + 141);
    expect(replay.frames.at(-1).type).toBe("events");
    for (const frame of replay.frames)
      expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(
        512 * 1024,
      );
    expect(replay.socket.readyState).toBe(WebSocket.OPEN);
  }, 30_000);
}

it("enforces paired sessions, Origin, Cards credential restrictions and owner isolation", async () => {
  const f = await fixture();
  seed(f);
  seed(f, "someone-else", "other-");
  for (const headers of [
    { origin: f.origin },
    { ...f.browser, origin: "https://elsewhere.example" },
    { ...f.browser, authorization: "Bearer cards-credential" },
    { ...f.browser, "sec-fetch-site": "cross-site" },
  ]) {
    const { socket } = connect(f, "", headers as typeof f.browser);
    const status = await new Promise<number>((resolve) =>
      socket.on("unexpected-response", (_req, res) => {
        resolve(res.statusCode!);
        res.resume();
        socket.terminate();
      }),
    );
    expect([401, 403]).toContain(status);
  }
  const { socket, frames } = connect(f, "?v=3&owner=someone-else");
  await expect.poll(() => frames.length).toBe(1);
  emit(f, "private-other-owner", "someone-else", "other-run");
  f.db.prepare("UPDATE runs SET state='completed' WHERE id='other-run'").run();
  const own = Number(emit(f, "visible-own-event"));
  await expect.poll(() => frames.length).toBeGreaterThan(1);
  expect(
    frames.flatMap((frame) => frame.events || []).map((event) => event.id),
  ).toEqual([own]);
  // The event channel is read-only: a client command never reaches the run.
  socket.send(JSON.stringify({ type: "cancel", run: "run" }));
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(f.db.prepare("SELECT state FROM runs WHERE id='run'").get()).toEqual({
    state: "running",
  });
}, 30_000);

it("closes an established socket when its paired device is revoked", async () => {
  const f = await fixture();
  const { socket, frames } = connect(f);
  await expect.poll(() => frames.length).toBe(1);
  const session = await (
    await f.request("/session", { headers: { cookie: f.browser.cookie } })
  ).json();
  const revoked = await f.request("/api/workspace/revoke", {
    body: { id: session.device.id },
    headers: f.browser,
  });
  expect(revoked.status).toBe(200);
  await expect
    .poll(() => socket.readyState, { timeout: 28_000, interval: 500 })
    .toBe(WebSocket.CLOSED);
}, 35_000);

it("broadcasts to both owner sockets, isolates another owner, and releases subscriptions after repeated disconnects", async () => {
  const f = await fixture();
  seed(f);
  seed(f, "someone-else", "other-");
  const first = connect(f),
    second = connect(f);
  await expect
    .poll(() => [first.frames.length, second.frames.length])
    .toEqual([1, 1]);
  emit(f, "private-other-owner", "someone-else", "other-run");
  const event = emit(f, "both-owner-sockets");
  await expect
    .poll(() => [first.frames.at(-1)?.cursor, second.frames.at(-1)?.cursor])
    .toEqual([Number(event), Number(event)]);
  for (const connected of [first, second])
    expect(
      connected.frames
        .flatMap((frame) => frame.events || [])
        .map((entry: any) => entry.id),
    ).toEqual([Number(event)]);
  await expect.poll(() => f.eventSubscriberCount()).toBe(3);
  for (let n = 0; n < 24; n++) {
    const transient = connect(f);
    await expect.poll(() => transient.frames.length).toBe(1);
    transient.socket.close();
    await expect.poll(() => transient.socket.readyState).toBe(WebSocket.CLOSED);
    await expect.poll(() => f.eventSubscriberCount()).toBe(3);
  }
  for (const connected of [first, second]) connected.socket.close();
  await expect.poll(() => f.eventSubscriberCount()).toBe(1);
}, 30_000);

it("catches up every replay page without a later write even after the process cursor advanced", async () => {
  const f = await fixture();
  seed(f);
  const initial = connect(f);
  await expect.poll(() => initial.frames.length).toBe(1);
  const { epoch, cursor: baseline } = initial.frames[0];
  initial.socket.close();
  await expect.poll(() => f.eventSubscriberCount()).toBe(1);
  const ids: number[] = [];
  f.db
    .transaction(() => {
      for (let n = 0; n < 650; n++) ids.push(Number(emit(f, "backlog")));
    })
    .immediate();
  // This live subscriber resets to the last row while the process drains the
  // backlog. The reconnect below must still replay from its own cursor.
  const live = connect(f);
  await expect.poll(() => live.frames.at(-1)?.cursor).toBe(ids.at(-1));
  const replay = connect(f, `?v=3&epoch=${epoch}&cursor=${baseline}`);
  await expect.poll(() => replay.frames.at(-1)?.cursor).toBe(ids.at(-1));
  expect(replay.frames.length).toBeGreaterThan(1);
  expect(
    replay.frames.flatMap((frame) => frame.events).map((event) => event.id),
  ).toEqual(ids);
}, 15_000);

{
  it(`companion serves typed v3, bounds replay and makes revision-only changes actionable`, async () => {
    const f = await fixture();
    seed(f);
    const live = connect(f, "?v=3");
    await expect.poll(() => live.frames.length).toBe(1);
    expect(WorkspaceFrameV3.parse(live.frames[0])).toMatchObject({
      type: "reset",
      capabilities: COMPLETE_WORKSPACE_CAPABILITIES,
    });
    const insert = f.db.prepare(
      "INSERT INTO events(owner_id,run_id,type,payload,created_at) VALUES(?,'run',?,?,1)",
    );
    const valid = Number(
      insert.run(
        f.owner,
        "message.completed",
        JSON.stringify({ messageId: "message" }),
      ).lastInsertRowid,
    );
    await expect.poll(() => live.frames.at(-1)?.cursor).toBe(valid);
    expect(live.frames.at(-1).events[0]).toEqual({
      id: valid,
      event: {
        type: "message.completed",
        scope: { kind: "run", id: "run" },
        subject: { kind: "run", id: "run" },
        payload: { messageId: "message" },
      },
    });
    const historical = Number(
      insert.run(f.owner, "historical.unknown", "not json").lastInsertRowid,
    );
    await expect.poll(() => live.frames.at(-1)?.cursor).toBe(historical);
    expect(live.frames.at(-1).events[0].event).toEqual({
      type: "invalidate",
      scope: { kind: "collection", id: "all" },
    });
    const oversized = JSON.stringify({
      messageId: "message",
      text: "x".repeat(100_000),
    });
    const large = Number(
      insert.run(f.owner, "message.delta", oversized).lastInsertRowid,
    );
    await expect.poll(() => live.frames.at(-1)?.cursor).toBe(large);
    expect(live.frames.at(-1).events[0].event).toEqual({
      type: "invalidate",
      scope: { kind: "run", id: "run" },
    });
    expect(
      f.db.prepare("SELECT payload FROM events WHERE id=?").get(large),
    ).toEqual({ payload: oversized });
    // Multiple bounded pages must finish without any later write or reset.
    live.socket.close();
    await expect.poll(() => live.socket.readyState).toBe(WebSocket.CLOSED);
    const payload = JSON.stringify({
      messageId: "message",
      text: "x".repeat(60_000),
    });
    let last = large;
    f.db.transaction(() => {
      for (let i = 0; i < 24; i++)
        last = Number(
          insert.run(f.owner, "message.delta", payload).lastInsertRowid,
        );
    })();
    const replay = connect(
      f,
      `?v=3&epoch=${live.frames[0].epoch}&cursor=${large}`,
    );
    await expect.poll(() => replay.frames.at(-1)?.cursor).toBe(last);
    expect(replay.frames.length).toBeGreaterThan(1);
    expect(
      replay.frames
        .flatMap((frame) => frame.events)
        .filter((entry) => entry.event.type === "message.delta"),
    ).toHaveLength(24);
    for (const frame of replay.frames) {
      expect(WorkspaceFrameV3.parse(frame).type).toBe("events");
      expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(
        512 * 1024,
      );
    }
    const before = replay.frames.length;
    f.db
      .prepare(
        "INSERT INTO artifacts(id,owner_id,kind,title,content,created_at,updated_at) VALUES('revision-only',?,'markdown','Saved note','Body',1,1)",
      )
      .run(f.owner);
    await expect
      .poll(() => replay.frames.length, { timeout: 7000 })
      .toBeGreaterThan(before);
    const mutation = WorkspaceFrameV3.parse(replay.frames.at(-1));
    expect(mutation.type).toBe("events");
    expect(mutation.cursor).toBeGreaterThan(last);
    if (mutation.type === "events") {
      expect(
        mutation.events.some(
          ({ id, event }) =>
            id > last &&
            event.type === "invalidate" &&
            event.subject?.kind === "artifact" &&
            event.subject.id === "revision-only",
        ),
      ).toBe(true);
    }
  }, 30_000);
}

it("negotiates v3 through paired source routing into another compiled companion", async () => {
  const remote = await fixture(true);
  seed(remote);
  const paired = await fixture(true);
  await paired.linkCompanion(remote);
  seed(paired);
  const sources = await (
    await paired.request("/api/agent-sources", {
      headers: paired.browser,
    })
  ).json();
  expect(sources).toHaveLength(1);
  const linked = connect(
    paired,
    "?v=3&owner=untrusted",
    paired.browser,
    `/api/agent-sources/${encodeURIComponent(sources[0].id)}/events/ws`,
  );
  const direct = connect(remote, "?v=3");
  await expect.poll(() => linked.frames.length).toBe(1);
  await expect.poll(() => direct.frames.length).toBe(1);
  const { serverNow: _linkedNow, ...linkedReset } = linked.frames[0];
  const { serverNow: _directNow, ...directReset } = direct.frames[0];
  expect(WorkspaceFrameV3.parse({ ...linkedReset, serverNow: 0 })).toEqual(
    WorkspaceFrameV3.parse({ ...directReset, serverNow: 0 }),
  );
  const snapshot = await paired.request(
    `/api/agent-sources/${encodeURIComponent(sources[0].id)}/feed`,
    { headers: paired.browser },
  );
  expect(
    snapshot.status,
    `${await snapshot.clone().text()}\n${remote.stderr}\n${paired.stderr}`,
  ).toBe(200);
  expect(snapshot.headers.get("x-loop-change-epoch")).toBe(
    linked.frames[0].epoch,
  );
  expect(snapshot.headers.get("x-loop-next-deadline")).toBe("null");
  expect(Number(snapshot.headers.get("x-loop-server-now"))).toBeGreaterThan(
    Date.now() - 5000,
  );
  expect(linked.frames[0].capabilities).toEqual(
    COMPLETE_WORKSPACE_CAPABILITIES,
  );
  const insert =
    "INSERT INTO events(owner_id,run_id,type,payload,created_at) VALUES(?,'run','progress',?,1)";
  paired.db
    .prepare(insert)
    .run(paired.owner, JSON.stringify({ message: "Local only" }));
  const id = Number(
    remote.db
      .prepare(insert)
      .run(remote.owner, JSON.stringify({ message: "Remote only" }))
      .lastInsertRowid,
  );
  await expect.poll(() => linked.frames.at(-1)?.cursor).toBe(id);
  const frame = WorkspaceFrameV3.parse(linked.frames.at(-1));
  // Pending Feed projections may share this batch; inspect progress events
  // without depending on when the source's earlier projection flush ran.
  expect({
    ...frame,
    events:
      frame.type === "events"
        ? frame.events.filter(({ event }) => event.type === "progress")
        : [],
  }).toMatchObject({
    type: "events",
    events: [
      {
        id,
        event: { type: "progress", payload: { message: "Remote only" } },
      },
    ],
  });
  expect(JSON.stringify(linked.frames)).not.toContain("Local only");
  const resumed = connect(
    paired,
    `?v=3&epoch=${frame.epoch}&cursor=${id}`,
    paired.browser,
    `/api/agent-sources/${encodeURIComponent(sources[0].id)}/events/ws`,
  );
  await expect.poll(() => resumed.frames.length).toBeGreaterThan(0);
  expect(resumed.frames[0]).toMatchObject({
    type: "events",
    capabilities: COMPLETE_WORKSPACE_CAPABILITIES,
  });
}, 30_000);

// These cases start an isolated compiled server, like the other endpoint tests.
// Keep their fixture budget consistent; event polling retains its own bound.
it.each(["secret", "routing"] as const)(
  "revokes a connection with invalid %s through the compiled v3 endpoint",
  async (invalid) => {
    const f = await fixture();
    const socket = connect(f, "?v=3");
    await expect.poll(() => socket.frames.length).toBe(1);
    const metadata = invalid === "routing" ? '{"loopHarness":false}' : "{}";
    f.db
      .prepare(
        "INSERT INTO connections(id,owner_id,provider,label,secret,status,metadata,created_at) VALUES('status-connection',?,'openai','Fixture',?,'connected',?,1)",
      )
      .run(
        f.owner,
        invalid === "secret" ? "must stay secret" : f.fixtureSecret,
        metadata,
      );
    const response = await f.request("/api/connections/status-connection", {
      method: "DELETE",
      headers: f.browser,
    });
    expect(response.status).toBe(200);
    await expect
      .poll(() =>
        socket.frames
          .flatMap((frame) => frame.events || [])
          .find((entry) => entry.event?.type === "connection.status"),
      )
      .toMatchObject({
        event: {
          type: "connection.status",
          scope: { kind: "connection", id: "status-connection" },
          payload: { status: "disconnected" },
        },
      });
    expect(JSON.stringify(socket.frames)).not.toContain("must stay secret");
    expect(
      f.db
        .prepare(
          "SELECT secret,status,metadata FROM connections WHERE id='status-connection'",
        )
        .get(),
    ).toEqual({ secret: "", status: "disconnected", metadata });
    expect(f.db.prepare("SELECT count(*) n FROM runs").get()).toEqual({ n: 0 });
    socket.socket.close();
  },
  30_000,
);
