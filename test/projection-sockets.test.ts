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
  fixture = await cardsFixture("server", compiled.source);
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
    Number(response.headers.get("x-loop-change-cursor")),
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
