import { afterAll, beforeAll, expect, it } from "vitest";
import { WebSocket } from "ws";
import { cardsFixture } from "./helpers/cards-fixture";
import { compiledServerFixture } from "./helpers/compiled-server";
import { WorkspaceFrameV3 } from "../src/shared/workspace-events";
import {
  TranscriptProjection,
  type TranscriptEvent,
} from "../src/shared/transcript-projection";
let compiled: Awaited<ReturnType<typeof compiledServerFixture>>;
let fixture: Awaited<ReturnType<typeof cardsFixture>>;
const sockets: WebSocket[] = [];
beforeAll(async () => {
  compiled = await compiledServerFixture();
  fixture = await cardsFixture("server", compiled.source, { projectedWrites: true });
}, 30000);
afterAll(async () => {
  sockets.forEach((s) => s.terminate());
  await fixture?.close();
  await compiled?.close();
});
it("replays bounded, whole append events after disconnect halfway through a large reply against the compiled server", async () => {
  const f = fixture;
  f.db
    .prepare(
      "INSERT INTO conversations(id,owner_id,title,created_at) VALUES('thread',?,'Delta',1)",
    )
    .run(f.owner);
  f.db
    .prepare(
      "INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES('message',?,'thread','assistant','A',1)",
    )
    .run(f.owner);
  const projection = new TranscriptProjection();
  const frames: WorkspaceFrameV3[] = [];
  let disconnected = false,
    cursor = 0,
    epoch = "";
  const connect = (query: string, interrupt = false) => {
    const socket = new WebSocket(
      f.origin.replace("http:", "ws:") +
        "/api/events/ws?v=3&clock=1&projection=1" +
        query,
      { headers: f.browser },
    );
    sockets.push(socket);
    socket.on("message", (raw) => {
      if (interrupt && disconnected) return;
      expect(Buffer.byteLength(raw as Buffer)).toBeLessThanOrEqual(512 * 1024);
      const frame = WorkspaceFrameV3.parse(JSON.parse(String(raw)));
      frames.push(frame);
      epoch = frame.epoch;
      cursor = frame.cursor;
      if (frame.type === "events")
        for (const entry of frame.events)
          if (
            ["message.delta", "message.upsert", "message.remove"].includes(
              entry.event.type,
            )
          )
            expect(
              projection.apply(entry.id, entry.event as TranscriptEvent),
            ).not.toBe("gap");
      if (
        interrupt &&
        frame.type === "events" &&
        frame.events.some((e) => e.event.type === "message.delta")
      ) {
        disconnected = true;
        socket.terminate();
      }
    });
    return socket;
  };
  connect("", true);
  await expect.poll(() => frames.length).toBeGreaterThan(0);
  const response = await f.request("/api/conversations/thread", {
    headers: f.browser,
  });
  expect(response.status).toBe(200);
  const snapshot = await response.json();
  projection.install(snapshot.messages);
  expect(snapshot.projection.cursor).toBe(
    Number(response.headers.get("x-loop55-change-cursor")),
  );
  const text = "A" + '🙂中\n"\\'.repeat(100000);
  f.db.prepare("UPDATE messages SET content=? WHERE id='message'").run(text);
  await expect.poll(() => disconnected).toBe(true);
  expect(projection.rows()[0].content.length).toBeLessThan(text.length);
  connect("&epoch=" + epoch + "&cursor=" + cursor);
  await expect.poll(() => projection.rows()[0]?.content).toBe(text);
  expect(
    frames.some(
      (frame) =>
        frame.type === "events" && frame.capabilities?.transcript === "delta",
    ),
  ).toBe(true);
  const final = await (
    await f.request("/api/conversations/thread", { headers: f.browser })
  ).json();
  expect(projection.rows()).toEqual(final.messages);
  const replacement = "Replacement " + "x".repeat(70 * 1024);
  const beforeReplacement = (f.db.prepare("SELECT max(id) n FROM events WHERE owner_id=?").get(f.owner) as {n:number}).n;
  f.db.prepare("UPDATE messages SET content=? WHERE id='message'").run(replacement);
  await expect.poll(() => frames.flatMap(frame => frame.type === "events" ? frame.events : [])
    .some(entry => entry.id > beforeReplacement && entry.event.type === "invalidate" && entry.event.subject?.kind === "message" && entry.event.subject.id === "message")).toBe(true);
  const fallback = frames.flatMap(frame => frame.type === "events" ? frame.events : [])
    .find(entry => entry.id > beforeReplacement && entry.event.subject?.id === "message");
  expect(fallback?.event).toMatchObject({
    type: "invalidate", scope: { kind: "conversation", id: "thread" },
    subject: { kind: "message", id: "message" },
  });
  const stored = f.db.prepare("SELECT type,payload FROM events WHERE id=?").get(fallback!.id) as {type:string;payload:string};
  expect(stored.type).toBe("invalidate");
  expect(Buffer.byteLength(stored.payload)).toBeLessThan(60 * 1024);
  const recovered = await (await f.request("/api/conversations/thread?message=message", {headers:f.browser})).json();
  projection.install(recovered.messages, recovered.projection.cursor, recovered.range, false);
  expect(projection.rows()[0].content).toBe(replacement);
}, 15000);
it("serves atomic per-page Feed deltas with upserts, removals, filter changes and owner isolation", async () => {
  const { reduceFeedPage } = await import("../src/shared/feed-projection");
  const f = fixture;
  f.db
    .prepare(
      "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,created_at) VALUES('feed-agent',?,'Agent','agent','openai','fixture',1)",
    )
    .run(f.owner);
  const create = (id: string, owner = f.owner) =>
    f.db
      .transaction(() => {
        f.db
          .prepare(
            "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,'feed-agent',?,1)",
          )
          .run(id, owner, id);
        f.db
          .prepare(
            "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,created_at,updated_at) VALUES(?,?,'feed-agent',?,?,'running',?,1,1)",
          )
          .run(id, owner, id, id, id);
        f.db
          .prepare("UPDATE runs SET created_at=?,updated_at=? WHERE id=?")
          .run(Date.now(), Date.now(), id);
      })
      .immediate();
  create("feed-a");
  create("feed-b");
  const read = async (path: string) => {
    const r = await f.request(path, { headers: f.browser });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.projection.cursor).toBe(
      Number(r.headers.get("x-loop55-change-cursor")),
    );
    return body;
  };
  const first = await read("/api/feed?filter=working");
  expect(first.items.map((i: any) => i.conversation_id)).toContain("feed-a");
  const token = (p: any) =>
    encodeURIComponent(
      JSON.stringify({
        epoch: p.projection.epoch,
        selection: p.projectionRows.selection,
        entities: p.projectionRows.entities,
      }),
    );
  f.db.prepare("UPDATE runs SET input='Edited' WHERE id='feed-a'").run();
  const inline = f.db.prepare("SELECT payload FROM events WHERE owner_id=? AND type='feed.card' AND json_extract(payload,'$.conversationId')='feed-a' ORDER BY id DESC LIMIT 1")
    .get(f.owner) as { payload: string };
  expect(JSON.parse(inline.payload).card).toMatchObject({ title: "Edited" });
  const delta = await read("/api/feed?filter=working&known=" + token(first));
  expect(delta.projectionRows.delta).toBe(true);
  expect(delta.items.map((i: any) => i.conversation_id)).toEqual(["feed-a"]);
  let shown = reduceFeedPage(first, delta);
  expect(shown.items).toEqual((await read("/api/feed?filter=working")).items);
  f.db.transaction(() => {
    f.db.prepare("INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES('feed-long-answer',?,'feed-b','feed-b','assistant',?,2)")
      .run(f.owner, "Large streamed answer ".repeat(2000));
    f.db.prepare("UPDATE runs SET updated_at=updated_at+1 WHERE id='feed-b'").run();
  }).immediate();
  const largeSignals = f.db.prepare("SELECT payload FROM events WHERE owner_id=? AND id>? AND type='feed.card' AND json_extract(payload,'$.conversationId')='feed-b' ORDER BY id")
    .all(f.owner, shown.projection.cursor) as { payload: string }[];
  expect(largeSignals.map(event => JSON.parse(event.payload))).toEqual([
    { conversationId: "feed-b", cardKey: "run:feed-b", kind: "thread", removed: true, card: null },
    { conversationId: "feed-b", cardKey: "message:feed-long-answer", kind: "thread", removed: false, card: null },
  ]);
  for (const event of largeSignals) expect(Buffer.byteLength(event.payload)).toBeLessThan(4096);
  const largeDelta = await read("/api/feed?filter=working&known=" + token(shown));
  expect(largeDelta.items.map((item: any) => item.conversation_id)).toEqual(["feed-b"]);
  shown = reduceFeedPage(shown, largeDelta);
  expect(reduceFeedPage(shown, largeDelta).items).toEqual(shown.items);
  expect(shown.items).toEqual((await read("/api/feed?filter=working")).items);
  f.db.prepare("UPDATE runs SET state='completed' WHERE id='feed-a'").run();
  const emitted = f.db.prepare("SELECT id,payload FROM events WHERE owner_id=? AND id>? AND type='feed.card' AND json_extract(payload,'$.conversationId')='feed-a'")
    .all(f.owner, shown.projection.cursor) as {id:number;payload:string}[];
  expect(emitted.some(event => JSON.parse(event.payload).kind === "thread")).toBe(true);
  const removed = await read("/api/feed?filter=working&known=" + token(shown));
  expect(removed.projectionRows.removed).toContain(
    JSON.stringify(["feed-a", null]),
  );
  expect(removed.projection.cursor).toBeGreaterThanOrEqual(Math.max(...emitted.map(event => event.id)));
  shown = reduceFeedPage(shown, removed);
  expect(reduceFeedPage(shown, removed).items).toEqual(shown.items);
  expect(shown.items).toEqual((await read("/api/feed?filter=working")).items);
  const changedFilter = await read(
    "/api/feed?filter=done&known=" + token(shown),
  );
  expect(changedFilter.projectionRows.delta).toBe(false);
  const before = shown.projection.cursor;
  expect(() =>
    f.db
      .transaction(() => {
        f.db.prepare("DELETE FROM messages WHERE run_id='feed-b'").run();
        f.db.prepare("DELETE FROM runs WHERE id='feed-b'").run();
        throw Error("rollback");
      })
      .immediate(),
  ).toThrow("rollback");
  const unchanged = await read(
    "/api/feed?filter=working&known=" + token(shown),
  );
  expect(unchanged.items).toEqual([]);
  expect(unchanged.projection.cursor).toBe(before);
  create("feed-private", "other-owner");
  const isolated = await read("/api/feed?filter=working&known=" + token(shown));
  expect(isolated.items).toEqual([]);
  expect(isolated.projection.cursor).toBe(before);
}, 15000);
