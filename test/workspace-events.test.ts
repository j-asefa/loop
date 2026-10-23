import { afterAll, beforeAll, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createConnection } from "node:net";
import { cardsFixture } from "./helpers/cards-fixture";
import { compiledServerFixture } from "./helpers/compiled-server";

let compiled: Awaited<ReturnType<typeof compiledServerFixture>>;
beforeAll(async () => {
  compiled = await compiledServerFixture();
}, 30_000);

const fixtures: Awaited<ReturnType<typeof cardsFixture>>[] = [];
const sockets: WebSocket[] = [];
afterAll(async () => {
  for (const socket of sockets) socket.terminate();
  await Promise.all(fixtures.map((fixture) => fixture.close()));
  await compiled?.close();
});
async function fixture(mode: Parameters<typeof cardsFixture>[0]) {
  const result = await cardsFixture(mode, compiled.source);
  fixtures.push(result);
  return result;
}
function connect(
  f: Awaited<ReturnType<typeof fixture>>,
  query = "",
  headers = f.browser,
) {
  const socket = new WebSocket(
    f.origin.replace("http:", "ws:") + "/api/events/ws" + query,
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

it("keeps the server available when rejected upgrade clients reset their sockets", async () => {
  const f = await fixture("server");
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

for (const mode of ["server", "companion"] as const) {
  it(`${mode} rejects malformed upgrade URLs without stopping the listener`, async () => {
    const f = await fixture(mode);
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

  it(`${mode} pushes Working/Done changes, save/dismiss revisions and reconnect catch-up`, async () => {
    const f = await fixture(mode);
    seed(f);
    const { socket, frames } = connect(f);
    await expect.poll(() => frames.length, { timeout: 7000 }).toBe(1);
    expect(frames[0]).toMatchObject({ v: 2, type: "reset", cursor: 0 });
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
    // There is no run event: revision changes alone must wake the browser.
    expect(frames.at(-1)).toMatchObject({
      type: "events",
      cursor: 0,
      events: [],
    });
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
    const replay = connect(f, `?epoch=${epoch}&cursor=${first}`);
    await expect.poll(() => replay.frames.length).toBeGreaterThan(0);
    expect(replay.frames[0]).toMatchObject({
      type: "events",
      cursor: Number(second),
      events: [{ type: "while-disconnected" }],
    });
    const reset = connect(f, "?epoch=previous-process&cursor=999999");
    await expect.poll(() => reset.frames.length).toBeGreaterThan(0);
    expect(reset.frames[0]).toMatchObject({
      type: "reset",
      cursor: Number(second),
    });
  }, 40_000);

  it(`${mode} reconciles oversized event replays without a repeated disconnect`, async () => {
    const f = await fixture(mode);
    seed(f);
    const first = connect(f);
    await expect.poll(() => first.frames.length).toBe(1);
    const { epoch } = first.frames[0];
    first.socket.close();
    await expect.poll(() => first.socket.readyState).toBe(WebSocket.CLOSED);
    // Durable results need not fit a transport frame. This batch exceeds the
    // linked gateway's 8 MiB frame limit without any individual giant result.
    const payload = JSON.stringify({ text: "x".repeat(96 * 1024) });
    const insert = f.db.prepare(
      "INSERT INTO events(owner_id,run_id,type,payload,created_at) VALUES(?,'run','workflow.completed',?,1)",
    );
    f.db.transaction(() => {
      for (let n = 0; n < 100; n++) insert.run(f.owner, payload);
    })();
    const replay = connect(f, `?epoch=${epoch}&cursor=0`);
    await expect.poll(() => replay.frames.length).toBeGreaterThan(0);
    expect(replay.frames[0].type).toBe("reset");
    expect(replay.frames[0].cursor).toBe(100);
    expect(replay.frames[0].events).toEqual([]);
    expect(Buffer.byteLength(JSON.stringify(replay.frames[0]))).toBeLessThan(
      1024 * 1024,
    );
    expect(
      f.db
        .prepare("SELECT payload FROM events WHERE owner_id=? LIMIT 1")
        .get(f.owner),
    ).toEqual({ payload });
    const next = emit(f, "after-large-replay");
    await expect.poll(() => replay.frames.at(-1)?.cursor).toBe(Number(next));
    expect(replay.frames.at(-1)).toMatchObject({
      type: "events",
      events: [{ type: "after-large-replay" }],
    });
    // Many individually small payloads must also respect the total budget.
    f.db.transaction(() => {
      for (let n = 0; n < 40; n++)
        insert.run(f.owner, JSON.stringify({ text: "x".repeat(48 * 1024) }));
    })();
    await expect.poll(() => replay.frames.at(-1)?.cursor).toBe(141);
    expect(replay.frames.at(-1).type).toBe("reset");
    expect(replay.frames.at(-1).events).toEqual([]);
    expect(replay.socket.readyState).toBe(WebSocket.OPEN);
  }, 30_000);
}

it("enforces server sessions, Origin, Cards credential restrictions and owner isolation", async () => {
  const f = await fixture("multi-user");
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
  const { socket, frames } = connect(f, "?owner=someone-else");
  await expect.poll(() => frames.length).toBe(1);
  emit(f, "private-other-owner", "someone-else", "other-run");
  f.db.prepare("UPDATE runs SET state='completed' WHERE id='other-run'").run();
  emit(f, "visible-own-event");
  await expect.poll(() => frames.length).toBeGreaterThan(1);
  expect(
    frames.flatMap((frame) => frame.events || []).map((event) => event.type),
  ).toEqual(["visible-own-event"]);
  socket.send(JSON.stringify({ type: "cancel", run: "run" }));
  await expect.poll(() => socket.readyState).toBe(WebSocket.CLOSED);
  expect(f.db.prepare("SELECT state FROM runs WHERE id='run'").get()).toEqual({
    state: "running",
  });
}, 30_000);

it("closes an established socket when its account session is revoked", async () => {
  const f = await fixture("multi-user");
  const { socket, frames } = connect(f);
  await expect.poll(() => frames.length).toBe(1);
  const signedOut = await f.request("/api/auth/sign-out", {
    body: {},
    headers: f.browser,
  });
  expect(signedOut.status).toBe(200);
  await expect
    .poll(() => socket.readyState, { timeout: 28_000, interval: 500 })
    .toBe(WebSocket.CLOSED);
}, 35_000);

it("broadcasts to both owner sockets, isolates another owner, and releases subscriptions after repeated disconnects", async () => {
  const f = await fixture("multi-user");
  seed(f);
  const response = await f.request("/api/auth/sign-up/email", {
    headers: { origin: f.origin },
    body: {
      name: "Second owner",
      email: "second@example.com",
      password: "fixture-second-owner-password",
    },
  });
  expect(response.status).toBe(200);
  const secondOwner = (await response.json()).user.id;
  seed(f, secondOwner, "other-");
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  const first = connect(f),
    second = connect(f);
  const other = connect(f, "", { ...f.browser, cookie });
  await expect
    .poll(() => [
      first.frames.length,
      second.frames.length,
      other.frames.length,
    ])
    .toEqual([1, 1, 1]);
  const event = emit(f, "both-owner-sockets");
  await expect
    .poll(() => [first.frames.at(-1)?.cursor, second.frames.at(-1)?.cursor])
    .toEqual([Number(event), Number(event)]);
  expect(other.frames).toHaveLength(1);
  expect(first.frames.at(-1).events.map((event: any) => event.type)).toEqual([
    "both-owner-sockets",
  ]);
  expect(second.frames.at(-1).events.map((event: any) => event.type)).toEqual([
    "both-owner-sockets",
  ]);
  await expect.poll(() => f.eventSubscriberCount()).toBe(3);
  for (let n = 0; n < 24; n++) {
    const transient = connect(f);
    await expect.poll(() => transient.frames.length).toBe(1);
    transient.socket.close();
    await expect.poll(() => transient.socket.readyState).toBe(WebSocket.CLOSED);
    await expect.poll(() => f.eventSubscriberCount()).toBe(3);
  }
  for (const connected of [first, second, other]) connected.socket.close();
  await expect.poll(() => f.eventSubscriberCount()).toBe(0);
}, 30_000);

it("catches up every replay page without a later write even after the process cursor advanced", async () => {
  const f = await fixture("server");
  seed(f);
  const initial = connect(f);
  await expect.poll(() => initial.frames.length).toBe(1);
  const { epoch } = initial.frames[0];
  initial.socket.close();
  await expect.poll(() => f.eventSubscriberCount()).toBe(0);
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
  const replay = connect(f, `?epoch=${epoch}&cursor=0`);
  await expect.poll(() => replay.frames.at(-1)?.cursor).toBe(ids.at(-1));
  expect(replay.frames.length).toBeGreaterThan(1);
  expect(
    replay.frames.flatMap((frame) => frame.events).map((event) => event.id),
  ).toEqual(ids);
}, 15_000);
