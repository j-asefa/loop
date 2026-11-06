import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { WebSocket } from "ws";
import { cardsFixture } from "./helpers/cards-fixture";
import { compiledServerFixture } from "./helpers/compiled-server";
import {
  WorkspaceFrameV3,
  eventScopes,
  type WorkspaceEvent,
} from "../src/shared/workspace-events";
import { cardTokenRequest } from "../src/shared/card-access";
import { z } from "zod";

let compiled: Awaited<ReturnType<typeof compiledServerFixture>>;
const sockets: WebSocket[] = [];
beforeAll(async () => {
  compiled = await compiledServerFixture();
}, 30_000);
// Servers started inside a test close with that test (see cardsFixture).
afterEach(() => {
  sockets.splice(0).forEach((socket) => socket.terminate());
});
afterAll(async () => {
  await compiled.close();
});
function fixture() {
  return cardsFixture(compiled.source);
}
function watch(f: Awaited<ReturnType<typeof fixture>>, query = "") {
  const socket = new WebSocket(
    f.origin.replace("http:", "ws:") + "/api/events/ws?v=3&clock=1" + query,
    { headers: f.browser },
  );
  sockets.push(socket);
  const frames: WorkspaceFrameV3[] = [];
  socket.on("message", (raw) =>
    frames.push(WorkspaceFrameV3.parse(JSON.parse(String(raw)))),
  );
  return {
    socket,
    frames,
    events: () =>
      frames.flatMap((frame) => (frame.type === "events" ? frame.events : [])),
  };
}
function seed(f: Awaited<ReturnType<typeof fixture>>) {
  if (!f.fixtureSecret)
    throw new Error("This route fixture requires its single owner credential");
  f.db
    .prepare(
      "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES('connection',?,'openai','Fixture',?,'connected','[{\"id\":\"fixture\"}]',1)",
    )
    .run(f.owner, f.fixtureSecret);
  for (const agent of ["agent", "worker", "extra"])
    f.db
      .prepare(
        "INSERT INTO agents(id,owner_id,name,normalized_name,provider,connection_id,model,created_at) VALUES(?,?,?,?,'openai','connection','fixture',1)",
      )
      .run(agent, f.owner, agent, agent);
  f.db
    .prepare(
      "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES('thread',?,'agent','Thread',1)",
    )
    .run(f.owner);
  f.db
    .prepare(
      "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,created_at,updated_at) VALUES('run',?,'agent','thread','Prompt','completed','key',1,1)",
    )
    .run(f.owner);
  f.db
    .prepare(
      "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES('message',?,'thread','run','assistant','Answer',2)",
    )
    .run(f.owner);
}
it.each(["mutation", "socket"] as const)(
  "reads a new owner's snapshot clock under a writer lock before its first %s",
  async (first) => {
    const f = await fixture();
    await f.setBusyTimeout(20);
    expect(
      f.db
        .prepare("SELECT * FROM change_watermark WHERE owner_id=?")
        .get(f.owner),
    ).toBeUndefined();
    let epoch: string | null = null;
    f.db.exec("BEGIN IMMEDIATE");
    try {
      for (let read = 0; read < 2; read++) {
        const response = await f.request("/api/auth/get-session", {
          headers: f.browser,
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          user: { id: f.owner },
          mode: "paired",
        });
        const received = response.headers.get("x-loop-change-epoch");
        expect(received).toBeTruthy();
        if (epoch) expect(received).toBe(epoch);
        epoch = received;
        expect(response.headers.get("x-loop-change-cursor")).toBe("0");
        expect(response.headers.get("x-loop-next-deadline")).toBe("null");
        expect(
          Number(response.headers.get("x-loop-server-now")),
        ).toBeGreaterThan(0);
        expect(
          f.db
            .prepare("SELECT * FROM change_watermark WHERE owner_id=?")
            .get(f.owner),
        ).toBeUndefined();
      }
    } finally {
      f.db.exec("ROLLBACK");
    }
    if (first === "mutation") {
      const created = await f.request("/api/folders", {
        headers: f.browser,
        body: { kind: "project", name: "First project" },
      });
      expect(created.status).toBeLessThan(300);
    }
    const stream = watch(f);
    await expect.poll(() => stream.frames.length).toBeGreaterThan(0);
    expect(stream.frames[0].epoch).toBe(epoch);
    expect(
      f.db
        .prepare("SELECT epoch FROM change_watermark WHERE owner_id=?")
        .get(f.owner),
    ).toEqual({ epoch });
    const after = await f.request("/api/auth/get-session", {
      headers: f.browser,
    });
    expect(after.status).toBe(200);
    expect(after.headers.get("x-loop-change-epoch")).toBe(epoch);
    if (first === "mutation")
      expect(Number(after.headers.get("x-loop-change-cursor"))).toBeGreaterThan(
        0,
      );
    else expect(after.headers.get("x-loop-change-cursor")).toBe("0");
  },
  10_000,
);

it("signals Social digest routes and worker status without leaking another owner's changes", async () => {
  const f = await fixture();
  seed(f);
  const stream = watch(f);
  await expect.poll(() => stream.frames.length).toBeGreaterThan(0);
  const tip = () =>
    (
      f.db
        .prepare(
          "SELECT last_event_id n FROM change_watermark WHERE owner_id=?",
        )
        .get(f.owner) as { n: number }
    ).n;
  const call = async (path: string, body?: unknown, method?: string) => {
    const response = await f.request("/api/social/digests" + path, {
      headers: f.browser,
      body,
      method,
    });
    const value = await response.json();
    expect(response.status, JSON.stringify(value)).toBeLessThan(300);
    return value;
  };
  const changed = async (mutate: () => unknown, type = "invalidate") => {
    const before = tip();
    const value = await mutate();
    await expect
      .poll(
        () =>
          stream
            .events()
            .some(
              ({ id, event }) =>
                id > before &&
                event.type === type &&
                event.subject?.kind === "collection" &&
                event.subject.id === "social" &&
                eventScopes(event).some(
                  (scope) =>
                    scope.kind === "collection" && scope.id === "social",
                ),
            ),
        { timeout: 1500 },
      )
      .toBe(true);
    return value;
  };
  const input = {
    agentId: "agent",
    conversationId: "thread",
    minuteOfDay: 480,
    zone: "UTC",
    unreadOnly: false,
  };
  const digest = (await changed(() => call("", input))) as { id: string };
  await changed(() =>
    call("/" + digest.id, { ...input, enabled: false }, "PATCH"),
  );
  const beforeNoop = tip();
  await call("/" + digest.id, { ...input, enabled: false }, "PATCH");
  expect(tip()).toBe(beforeNoop);
  await changed(() =>
    f.db
      .prepare(
        "UPDATE feed_digests SET last_run_at=100,last_error='Missing agent',enabled=0 WHERE id=?",
      )
      .run(digest.id),
  );
  expect((await call("")).digests).toEqual([
    expect.objectContaining({
      id: digest.id,
      last_run_at: 100,
      last_error: "Missing agent",
      enabled: 0,
    }),
  ]);
  await changed(() =>
    call("/" + digest.id, { ...input, enabled: true }, "PATCH"),
  );
  expect((await call("")).digests).toEqual([
    expect.objectContaining({ id: digest.id, enabled: 1, last_error: null }),
  ]);
  const beforeForeign = tip();
  f.db
    .prepare(
      "INSERT INTO feed_digests(id,owner_id,agent_id,minute_of_day,zone,created_at) VALUES('foreign-digest','foreign','foreign-agent',0,'UTC',1)",
    )
    .run();
  const foreignTip = f.db
    .prepare(
      "SELECT last_event_id FROM change_watermark WHERE owner_id='foreign'",
    )
    .get();
  const denied = await f.request("/api/social/digests/foreign-digest", {
    headers: f.browser,
    method: "DELETE",
  });
  expect(denied.status).toBe(404);
  expect(tip()).toBe(beforeForeign);
  expect(
    f.db
      .prepare(
        "SELECT last_event_id FROM change_watermark WHERE owner_id='foreign'",
      )
      .get(),
  ).toEqual(foreignTip);
  await changed(() => call("/" + digest.id, undefined, "DELETE"), "tombstone");
  expect((await call("")).digests).toEqual([]);
}, 10_000);

it("preserves the strict pre-deadline v3 reset envelope for already-loaded clients", async () => {
  const f = await fixture();
  seed(f);
  // Frozen reset decoder from 1d3ece4, before clock fields were added to v3.
  const legacyReset = z.strictObject({
    v: z.literal(3),
    type: z.literal("reset"),
    epoch: z.string().min(1).max(200),
    cursor: z.number().int().nonnegative(),
    build: z.string().max(1000),
    buildIdentity: z.unknown(),
    capabilities: z.strictObject({
      invalidations: z.enum(["partial", "complete"]),
      deadlines: z.boolean(),
      transcript: z.enum(["snapshot", "delta"]),
      feed: z.enum(["snapshot", "delta"]),
      results: z.enum(["snapshot", "delta"]),
    }),
  });
  const socket = new WebSocket(
    f.origin.replace("http:", "ws:") + "/api/events/ws?v=3",
    { headers: f.browser },
  );
  sockets.push(socket);
  const frames: unknown[] = [];
  socket.on("message", (raw) => frames.push(JSON.parse(String(raw))));
  await expect.poll(() => frames.length).toBeGreaterThan(0);
  const reset = legacyReset.parse(frames[0]);
  expect(reset.build).toBeTruthy(); // The old client's reload handler can run.
  expect(reset.capabilities.deadlines).toBe(false);
  expect(socket.readyState).toBe(WebSocket.OPEN);
});

it("delivers ordinary changes while another writer holds the database lock", async () => {
  const f = await fixture();
  seed(f);
  const expiry = Date.now() + 60_000;
  pendingApproval(f, "future", expiry);
  const stream = watch(f);
  await expect.poll(() => stream.frames.length).toBeGreaterThan(0);
  await expect
    .poll(() =>
      f.db
        .prepare("SELECT next_deadline FROM change_deadlines WHERE owner_id=?")
        .get(f.owner),
    )
    .toEqual({ next_deadline: expiry });
  const before = (
    f.db
      .prepare("SELECT last_event_id n FROM change_watermark WHERE owner_id=?")
      .get(f.owner) as { n: number }
  ).n;
  f.db
    .prepare("UPDATE messages SET content='Changed' WHERE id='message'")
    .run();
  f.db.exec("BEGIN IMMEDIATE");
  try {
    await expect
      .poll(
        () =>
          stream
            .events()
            .some(
              ({ id, event }) =>
                id > before && event.subject?.kind === "message",
            ),
        { timeout: 1200 },
      )
      .toBe(true);
  } finally {
    f.db.exec("ROLLBACK");
  }
}, 10_000);

it("connects existing owners without a writer lock and releases failed socket reservations", async () => {
  const f = await fixture();
  seed(f);
  await f.setBusyTimeout(20);
  f.db.exec("BEGIN IMMEDIATE");
  try {
    const connected = watch(f);
    connected.socket.on("error", () => {});
    await expect
      .poll(() => connected.frames.length, { timeout: 1200 })
      .toBeGreaterThan(0);
    connected.socket.close();
    await expect.poll(() => connected.socket.readyState).toBe(WebSocket.CLOSED);
  } finally {
    f.db.exec("ROLLBACK");
  }
  // A first connection must create the owner's durable clock. Force those
  // writes to fail, then prove all twelve owner slots are available afterward.
  f.db.prepare("DELETE FROM change_watermark WHERE owner_id=?").run(f.owner);
  f.db.exec("BEGIN IMMEDIATE");
  const codes: number[] = [];
  try {
    for (let attempt = 0; attempt < 12; attempt++) {
      const socket = new WebSocket(
        f.origin.replace("http:", "ws:") + "/api/events/ws?v=3&clock=1",
        { headers: f.browser },
      );
      sockets.push(socket);
      socket.on("error", () => {});
      let closed = false;
      socket.on("close", (code) => {
        codes.push(code);
        closed = true;
      });
      await expect.poll(() => closed, { timeout: 1200 }).toBe(true);
    }
  } finally {
    f.db.exec("ROLLBACK");
  }
  const recovered = watch(f);
  recovered.socket.on("error", () => {});
  await expect
    .poll(() => recovered.frames.length, { timeout: 1200 })
    .toBeGreaterThan(0);
  expect(codes).toEqual(Array(12).fill(1011));
}, 15_000);

it("invalidates Later when target content, metadata or access changes", async () => {
  const f = await fixture();
  seed(f);
  const call = async (path: string, body?: unknown, method?: string) => {
    const response = await f.request("/api" + path, {
      headers: f.browser,
      body,
      method,
    });
    const value = await response.json();
    expect(response.status, JSON.stringify(value)).toBeLessThan(300);
    return value;
  };
  const folder = await call("/folders", { kind: "project", name: "Project" });
  const artifact = await call("/artifacts", {
    title: "Document",
    content: "Before",
    folder: folder.id,
  });
  await call("/social/feeds/hackernews", undefined, "PUT");
  f.db
    .prepare(
      "INSERT INTO feed_stories(feed_id,story_id,url,title,summary,story,first_seen_at,fetched_at) VALUES('hackernews','later-story','https://example.com/story','Story','Before',?,1,1)",
    )
    .run(
      JSON.stringify({
        id: "later-story",
        title: "Story",
        url: "https://example.com/story",
        summary: "Before",
        published_at: 1,
      }),
    );
  for (const [kind, targetId] of [
    ["conversation", "thread"],
    ["message", "message"],
    ["artifact", artifact.id],
    ["story", "hackernews:later-story"],
  ])
    await call("/later", {
      kind,
      targetId,
      condition: "time",
      dueAt: Date.now() + 3600_000,
    });
  f.db
    .prepare(
      "INSERT INTO feed_sources(id,owner_id,url,title,home,category,kind,color,created_at) VALUES('custom-later',?,'https://example.com/rss','Custom','example.com','News','post','blue',1)",
    )
    .run(f.owner);
  f.db
    .prepare(
      "INSERT INTO feed_stories(feed_id,story_id,url,title,story,first_seen_at,fetched_at) VALUES('custom-later','own','https://example.com/own','Own story',?,1,1)",
    )
    .run(
      JSON.stringify({
        id: "own",
        title: "Own story",
        url: "https://example.com/own",
        summary: "Own preview",
        published_at: 1,
      }),
    );
  await call("/later", {
    kind: "story",
    targetId: "custom-later:own",
    condition: "time",
    dueAt: Date.now() + 3600_000,
  });
  const stream = watch(f);
  await expect.poll(() => stream.frames.length).toBeGreaterThan(0);
  const changed = async (
    mutate: () => unknown,
    target: string,
    expected: object,
  ) => {
    const before = (
      f.db
        .prepare(
          "SELECT last_event_id n FROM change_watermark WHERE owner_id=?",
        )
        .get(f.owner) as { n: number }
    ).n;
    await mutate();
    await expect
      .poll(
        () =>
          stream
            .events()
            .some(
              ({ id, event }) =>
                id > before &&
                eventScopes(event).some(
                  (scope) =>
                    scope.kind === "collection" && scope.id === "later",
                ),
            ),
        { timeout: 1500 },
      )
      .toBe(true);
    const page = await call("/later");
    expect(
      page.upcoming.find(
        (item: { target_id: string }) => item.target_id === target,
      ),
    ).toMatchObject(expected);
  };
  await changed(
    () =>
      call(
        "/artifacts/" + artifact.id,
        { title: "Updated document", content: "After", version: 1 },
        "PATCH",
      ),
    artifact.id,
    { title: "Updated document", content: "After" },
  );
  await changed(
    () =>
      f.db
        .prepare(
          "UPDATE messages SET content='Edited message' WHERE id='message'",
        )
        .run(),
    "message",
    { content: "Edited message" },
  );
  await changed(
    () =>
      f.db
        .prepare(
          "UPDATE conversations SET title='Renamed thread' WHERE id='thread'",
        )
        .run(),
    "thread",
    { title: "Renamed thread", content: "Edited message" },
  );
  await changed(
    () => call("/agents/agent", { name: "renamed-agent" }, "PATCH"),
    "message",
    { agent_name: "renamed-agent" },
  );
  await changed(
    () =>
      f.db
        .prepare("UPDATE runs SET payload=? WHERE id='run'")
        .run(JSON.stringify({ folderId: folder.id })),
    "thread",
    { project_name: "Project" },
  );
  await changed(
    () => call("/folders/" + folder.id, { name: "Renamed project" }, "PATCH"),
    artifact.id,
    { project_name: "Renamed project" },
  );
  await changed(
    () =>
      f.db
        .prepare("UPDATE feed_stories SET story=? WHERE story_id='later-story'")
        .run(
          JSON.stringify({
            id: "later-story",
            title: "Edited story",
            url: "https://example.com/changed",
            summary: "Edited preview",
            published_at: 1,
          }),
        ),
    "hackernews:later-story",
    {
      title: "Edited story",
      preview: "Edited preview",
      url: "https://example.com/changed",
    },
  );
  await changed(
    () => call("/social/feeds/hackernews", undefined, "DELETE"),
    "hackernews:later-story",
    { title: "Item unavailable" },
  );
  await changed(
    () => call("/social/feeds/hackernews", undefined, "PUT"),
    "hackernews:later-story",
    { title: "Edited story" },
  );
  await changed(
    () =>
      f.db
        .prepare("DELETE FROM feed_stories WHERE story_id='later-story'")
        .run(),
    "hackernews:later-story",
    { title: "Item unavailable" },
  );
  await changed(
    () => f.db.prepare("DELETE FROM messages WHERE id='message'").run(),
    "message",
    { title: "Item unavailable" },
  );
  await changed(
    () => f.db.prepare("DELETE FROM artifacts WHERE id=?").run(artifact.id),
    artifact.id,
    { title: "Item unavailable" },
  );
  await changed(
    () => call("/social/sources/custom-later", undefined, "DELETE"),
    "custom-later:own",
    { title: "Item unavailable" },
  );
  await changed(
    () =>
      f.db.exec(
        "DELETE FROM runs WHERE id='run'; DELETE FROM conversations WHERE id='thread'",
      ),
    "thread",
    { title: "Item unavailable" },
  );
}, 20_000);

it(`companion delivers owned route mutations with explicit subjects and collection scopes`, async () => {
  const f = await fixture();
  seed(f);
  const stream = watch(f);
  await expect.poll(() => stream.frames.length).toBeGreaterThan(0);
  expect(stream.frames[0]).toMatchObject({
    type: "reset",
    capabilities: { invalidations: "complete", deadlines: true },
    nextDeadline: null,
  });
  const mutate = async (
    path: string,
    body: unknown,
    method: string,
    kind: string,
    collection: string,
    wantedId?: string,
    type = "invalidate",
  ) => {
    const cursor = (
      f.db
        .prepare("SELECT last_event_id FROM change_watermark WHERE owner_id=?")
        .get(f.owner) as { last_event_id: number }
    ).last_event_id;
    const res = await f.request("/api" + path, {
      method,
      body,
      headers: f.browser,
    });
    const result = await res.json();
    expect(res.status, JSON.stringify(result)).toBeLessThan(300);
    await expect
      .poll(
        () =>
          stream
            .events()
            .some(
              ({ id, event }) =>
                id > cursor &&
                event.type === type &&
                event.subject?.kind === kind &&
                (!wantedId || event.subject.id === wantedId) &&
                eventScopes(event).some(
                  (scope) =>
                    scope.kind === "collection" && scope.id === collection,
                ),
            ),
        { timeout: 2500 },
      )
      .toBe(true);
    return result;
  };
  const queued = await mutate(
    "/runs",
    {
      agentId: "agent",
      input: "Queued",
      idempotencyKey: "queued-fixture-key",
      queue: true,
    },
    "POST",
    "run",
    "runs",
  );
  expect(
    stream
      .events()
      .some(
        ({ event }) =>
          event.subject?.kind === "conversation" &&
          event.subject.id === queued.conversation_id,
      ),
  ).toBe(true);
  expect(
    stream
      .events()
      .some(
        ({ event }) =>
          event.subject?.kind === "message" &&
          eventScopes(event).some(
            (scope) =>
              scope.kind === "conversation" &&
              scope.id === queued.conversation_id,
          ),
      ),
  ).toBe(true);
  await mutate(
    "/runs/" + queued.id + "/cancel",
    {},
    "POST",
    "run",
    "feed",
    queued.id,
  );
  f.db
    .prepare(
      "INSERT INTO runs(id,owner_id,input,state,idempotency_key,created_at,updated_at) VALUES('approval-run',?,'Review','awaiting_approval','approval-key',1,1)",
    )
    .run(f.owner);
  f.db
    .prepare(
      "INSERT INTO approvals(id,owner_id,run_id,digest,request,state,created_at,expires_at) VALUES('action-approval',?,'approval-run','action','{}','pending',1,?)",
    )
    .run(f.owner, Date.now() + 60_000);
  await mutate(
    "/approvals/action-approval",
    { decision: "reject" },
    "POST",
    "approval",
    "approvals",
    "action-approval",
  );
  await expect
    .poll(() =>
      stream
        .events()
        .some(
          ({ event }) =>
            event.type === "invalidate" &&
            event.subject?.kind === "collection" &&
            event.subject.id === "decisions" &&
            eventScopes(event).some(
              (scope) =>
                scope.kind === "collection" && scope.id === "approvals",
            ),
        ),
    )
    .toBe(true);
  const history = await f.request("/api/me/decisions?kind=approval", {
    headers: f.browser,
  });
  expect(history.status).toBe(200);
  expect((await history.json()).items).toMatchObject([
    { id: "approval:action-approval", choice: "reject", state: "resolved" },
  ]);
  const subscription = {
    endpoint: "https://fcm.googleapis.com/fixture",
    keys: {
      p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString(
        "base64url",
      ),
      auth: Buffer.alloc(16, 1).toString("base64url"),
    },
  };
  await mutate(
    "/notifications/subscriptions",
    subscription,
    "POST",
    "collection",
    "metadata",
    "metadata",
  );
  await mutate(
    "/notifications/subscriptions",
    { endpoint: subscription.endpoint },
    "DELETE",
    "collection",
    "metadata",
    "metadata",
    "tombstone",
  );
  const folder = await mutate(
    "/folders",
    { name: "Project", kind: "project" },
    "POST",
    "folder",
    "metadata",
  );
  await mutate(
    "/folders/" + folder.id,
    { name: "Renamed" },
    "PATCH",
    "folder",
    "results",
    folder.id,
  );
  await mutate(
    "/agents/agent",
    { folderId: folder.id, instructions: "Updated" },
    "PATCH",
    "agent",
    "feed",
    "agent",
  );
  const artifact = await mutate(
    "/artifacts",
    { title: "Note", content: "Body", folder: folder.id },
    "POST",
    "artifact",
    "results",
  );
  await mutate(
    "/artifacts/" + artifact.id,
    { pinned: true, version: 1 },
    "PATCH",
    "artifact",
    "saved",
    artifact.id,
  );
  await mutate(
    "/results/" + artifact.id,
    { hidden: true },
    "PATCH",
    "artifact",
    "results",
    artifact.id,
  );
  await mutate(
    "/messages/message/saved",
    undefined,
    "POST",
    "message",
    "saved",
    "message",
  );
  await mutate(
    "/saved/label",
    { key: "m:message", label: "Keep" },
    "PUT",
    "collection",
    "saved",
    "saved",
  );
  await mutate(
    "/messages/message/saved",
    undefined,
    "DELETE",
    "collection",
    "saved",
    "saved",
    "tombstone",
  );
  await mutate(
    "/conversations/thread/position",
    { positionMessageId: "message" },
    "PUT",
    "conversation",
    "feed",
    "thread",
  );
  await mutate(
    "/feed/thread",
    { hidden: true, cardKey: "run:run" },
    "PATCH",
    "conversation",
    "feed",
    "thread",
  );
  const later = await mutate(
    "/later",
    {
      kind: "conversation",
      targetId: "thread",
      condition: "time",
      dueAt: Date.now() + 60_000,
    },
    "POST",
    "later",
    "later",
  );
  await mutate(
    "/later/" + later.id,
    undefined,
    "DELETE",
    "later",
    "later",
    later.id,
  );
  const scheduled = await mutate(
    "/scheduled-sends",
    {
      agentId: "agent",
      conversationId: "thread",
      input: "Later",
      idempotencyKey: "scheduled-fixture",
      sendAt: Date.now() + 60_000,
    },
    "POST",
    "scheduled_send",
    "scheduled",
  );
  await mutate(
    "/scheduled-sends/" + scheduled.id,
    undefined,
    "DELETE",
    "scheduled_send",
    "scheduled",
    scheduled.id,
  );
  const team = await mutate(
    "/teams",
    { name: "Team", managerId: "agent", members: ["worker"] },
    "POST",
    "team",
    "metadata",
  );
  await mutate(
    "/teams/" + team.id + "/members",
    { agentId: "extra" },
    "POST",
    "team",
    "mail",
    team.id,
  );
  await mutate(
    "/teams/" + team.id + "/feed-visibility",
    { hideResultsFromFeed: true },
    "PATCH",
    "team",
    "feed",
    team.id,
  );
  // Social mutation routes need no live feed fetch.
  await mutate(
    "/social/feeds/hackernews",
    undefined,
    "PUT",
    "collection",
    "social",
    "social",
  );
  await mutate(
    "/social/mutes",
    { phrase: "quiet" },
    "POST",
    "collection",
    "social",
    "social",
  );
  const feedWatch = await mutate(
    "/social/watches",
    { query: "fixture" },
    "POST",
    "collection",
    "social",
    "social",
  );
  await mutate(
    "/social/watches/" + feedWatch.id,
    undefined,
    "DELETE",
    "collection",
    "social",
    "social",
    "tombstone",
  );
  await mutate(
    "/social/preferences",
    { images: true },
    "PUT",
    "collection",
    "social",
    "social",
  );
  f.db
    .prepare(
      "INSERT INTO feed_stories(feed_id,story_id,url,title,story,first_seen_at,fetched_at) VALUES('hackernews','story','https://example.com/story','Story',?,1,1)",
    )
    .run(
      JSON.stringify({
        id: "story",
        title: "Story",
        url: "https://example.com/story",
        summary: "Fixture",
        published_at: 1,
      }),
    );
  await mutate(
    "/social/read",
    { stories: ["hackernews:story"] },
    "POST",
    "collection",
    "social",
    "social",
  );
  await mutate(
    "/social/dismiss",
    { stories: ["hackernews:story"] },
    "POST",
    "collection",
    "social",
    "social",
  );
  await mutate(
    "/social/read-all",
    { feed: "hackernews" },
    "POST",
    "collection",
    "social",
    "social",
  );
  await mutate(
    "/social/feeds/hackernews",
    undefined,
    "DELETE",
    "collection",
    "social",
    "social",
    "tombstone",
  );
  const response = await f.request("/api/feed", { headers: f.browser });
  expect(response.headers.get("x-loop-change-epoch")).toBe(
    stream.frames[0].epoch,
  );
  expect(Number(response.headers.get("x-loop-server-now"))).toBeGreaterThan(
    Date.now() - 5000,
  );
  expect(response.headers.get("x-loop-next-deadline")).toBe("null");
  expect(
    stream.frames
      .filter((frame) => frame.type === "events")
      .every((frame) => frame.events.length > 0),
  ).toBe(true);
}, 30_000);

it("emits no unauthorized deletion and retains a tombstone across a run cascade and replay hole", async () => {
  const f = await fixture();
  seed(f);
  f.db
    .prepare(
      "INSERT INTO connections(id,owner_id,provider,label,secret,status,created_at) VALUES('other','someone-else','openai','Private','not-used','connected',1)",
    )
    .run();
  // Raw fixture seeding bypasses the application's synchronous projector.
  // Finish setup through an owned production write before measuring whether
  // the unauthorized request emits anything.
  const positioned = await f.request("/api/conversations/thread/position", {
    method: "PUT",
    headers: f.browser,
    body: { positionMessageId: "message" },
  });
  expect(positioned.status).toBe(200);
  expect(f.db.prepare("SELECT * FROM feed_card_dirty").all()).toEqual([]);
  const stream = watch(f);
  await expect.poll(() => stream.frames.length).toBeGreaterThan(0);
  const before = f.db.prepare("SELECT count(*) n FROM events").get();
  const refused = await f.request("/api/connections/other", {
    method: "DELETE",
    headers: f.browser,
  });
  expect(refused.status).toBe(404);
  expect(f.db.prepare("SELECT count(*) n FROM events").get()).toEqual(before);
  // Root run deletion is an internal persistence operation; dependents have
  // already been removed, just as the production cleanup/import boundary does.
  const cursor = stream.frames.at(-1)!.cursor;
  f.db.exec(
    "DELETE FROM messages WHERE run_id='run'; DELETE FROM runs WHERE id='run'",
  );
  await expect
    .poll(() =>
      stream
        .events()
        .some(
          ({ id, event }) =>
            id > cursor &&
            event.type === "tombstone" &&
            event.removed.kind === "run" &&
            event.removed.id === "run",
        ),
    )
    .toBe(true);
  const tip = stream.frames.at(-1)!.cursor;
  f.db.exec("DELETE FROM events");
  const resumed = watch(
    f,
    `&epoch=${stream.frames[0].epoch}&cursor=${tip - 1}`,
  );
  await expect.poll(() => resumed.frames.length).toBeGreaterThan(0);
  expect(resumed.frames[0]).toMatchObject({ type: "reset", cursor: tip });
  f.db
    .prepare(
      "INSERT INTO feed_sources(id,owner_id,url,title,home,category,kind,color,created_at) VALUES('custom',?,'https://example.com/rss','Feed','example.com','News','post','blue',1)",
    )
    .run(f.owner);
  const deleted = await f.request("/api/social/sources/custom", {
    method: "DELETE",
    headers: f.browser,
  });
  expect(deleted.status).toBe(200);
  await expect
    .poll(() =>
      resumed
        .events()
        .some(
          ({ event }) =>
            event.type === "tombstone" &&
            event.removed.kind === "social" &&
            event.removed.id === "custom",
        ),
    )
    .toBe(true);
}, 15_000);

function pendingApproval(
  f: Awaited<ReturnType<typeof fixture>>,
  id: string,
  expires: number,
) {
  f.db
    .prepare(
      "INSERT INTO approvals(id,owner_id,run_id,digest,request,state,created_at,expires_at) VALUES(?,?,'run',?,'{}','pending',?,?)",
    )
    .run(id, f.owner, id, Date.now(), expires);
}
it(`companion keeps owner-wide change clocks out of scoped Cards responses`, async () => {
  const f = await fixture();
  seed(f);
  const expires = Date.now() + 60_000;
  pendingApproval(f, "private-approval", expires);
  f.db
    .prepare(
      "INSERT INTO artifacts(id,owner_id,agent_id,conversation_id,run_id,title,kind,content,metadata,created_at,updated_at) VALUES('published',?,'agent','thread','run','Result','markdown','Published','{}',1,1)",
    )
    .run(f.owner);
  const ownerResponse = await f.request("/api/v1/cards?view=results", {
    headers: f.browser,
  });
  expect(ownerResponse.status).toBe(200);
  expect(ownerResponse.headers.get("x-loop-next-deadline")).toBe(
    String(expires),
  );
  expect(ownerResponse.headers.has("x-loop-change-cursor")).toBe(true);
  for (const scope of ["results:read", "cards:read"] as const) {
    const created = await f.request("/api/card-tokens", {
      headers: f.browser,
      body: cardTokenRequest(scope, scope),
    });
    expect(created.status).toBe(201);
    const { secret } = await created.json();
    for (const headers of [
      { authorization: "Bearer " + secret },
      { ...f.browser, authorization: "Bearer " + secret },
    ]) {
      const page = await (
        await f.request("/api/v1/cards?view=results", { headers })
      ).json();
      expect(
        page.items.map((item: { card: { id: string } }) => item.card.id),
      ).toContain("a:published");
      for (const path of [
        "/api/v1/cards?view=results",
        "/api/v1/cards/changes?view=results&after=" +
          encodeURIComponent(page.revision),
        "/api/v1/cards/a%3Apublished",
      ])
        for (const method of ["GET", "HEAD"]) {
          const response = await f.request(path, { headers, method });
          expect(response.status).toBe(200);
          for (const header of [
            "x-loop-change-epoch",
            "x-loop-change-cursor",
            "x-loop-server-now",
            "x-loop-next-deadline",
          ])
            expect(
              response.headers.has(header),
              `${scope} ${method} ${path}: ${header}`,
            ).toBe(false);
        }
    }
  }
}, 15_000);

// The outer budget includes compiled-server startup and teardown; the deadline
// polling bounds below still enforce prompt expiry delivery and timer clearing.
it("initializes deadlines after creation and advertises two expiries without any intervening mutation", async () => {
  const f = await fixture();
  seed(f);
  const first = Date.now() + 1600,
    second = first + 1300;
  pendingApproval(f, "approval", first);
  f.db
    .prepare(
      "INSERT INTO pr_watches(id,owner_id,conversation_id,agent_id,repo_owner,repo_name,number,state,created_at,updated_at) VALUES('watch',?,'thread','agent','fixture','repo',1,'stopped',1,?)",
    )
    .run(f.owner, second - 604800000);
  const stream = watch(f);
  await expect.poll(() => stream.frames.length).toBeGreaterThan(0);
  expect(stream.frames[0]).toMatchObject({
    type: "reset",
    nextDeadline: first,
  });
  const snapshot = await f.request("/api/pr-watches", { headers: f.browser });
  expect(snapshot.headers.get("x-loop-next-deadline")).toBe(String(first));
  expect((await snapshot.json()).watches).toHaveLength(1);
  const nexts = () =>
    stream
      .events()
      .flatMap(({ event }) =>
        event.type === "deadline" ? [event.nextDeadline] : [],
      );
  await expect
    .poll(() => nexts().includes(second), { timeout: 2500 })
    .toBe(true);
  await expect.poll(() => nexts().includes(null), { timeout: 2500 }).toBe(true);
  expect(
    stream
      .events()
      .some(
        ({ event }) =>
          event.type === "invalidate" &&
          eventScopes(event).some((scope) => scope.id === "approvals"),
      ),
  ).toBe(true);
  expect(
    stream
      .events()
      .some(
        ({ event }) =>
          event.type === "invalidate" &&
          eventScopes(event).some((scope) => scope.id === "pulls"),
      ),
  ).toBe(true);
  expect(
    f.db
      .prepare("SELECT state,expires_at FROM approvals WHERE id='approval'")
      .get(),
  ).toEqual({ state: "pending", expires_at: first });
  expect(
    f.db.prepare("SELECT updated_at FROM pr_watches WHERE id='watch'").get(),
  ).toEqual({ updated_at: second - 604800000 });
  expect(
    (await (await f.request("/api/pr-watches", { headers: f.browser })).json())
      .watches,
  ).toEqual([]);
  expect(
    f.db.prepare("SELECT processed FROM change_expiries ORDER BY kind").all(),
  ).toEqual([{ processed: 1 }, { processed: 1 }]);
}, 30_000);

it("rearms when the earliest expiry is extended or deleted and explicitly clears the last timer", async () => {
  const f = await fixture();
  seed(f);
  const first = Date.now() + 2000,
    second = first + 1000,
    extended = second + 2000;
  pendingApproval(f, "first", first);
  pendingApproval(f, "second", second);
  const stream = watch(f);
  await expect.poll(() => stream.frames.length).toBeGreaterThan(0);
  const advertised = () =>
    stream
      .events()
      .flatMap(({ event }) =>
        event.type === "deadline" ? [event.nextDeadline] : [],
      )
      .at(-1);
  f.db
    .prepare("UPDATE approvals SET expires_at=? WHERE id='first'")
    .run(extended);
  await expect.poll(advertised).toBe(second);
  f.db.exec("DELETE FROM approvals WHERE id='second'");
  await expect.poll(advertised).toBe(extended);
  f.db.exec("DELETE FROM approvals WHERE id='first'");
  await expect.poll(advertised).toBeNull();
  const count = stream
    .events()
    .filter(({ event }) => event.type === "deadline").length;
  await expect
    .poll(() => Date.now() > second + 50, { timeout: 4000 })
    .toBe(true);
  expect(
    stream.events().filter(({ event }) => event.type === "deadline"),
  ).toHaveLength(count);
  expect(f.db.prepare("SELECT * FROM change_expiries").all()).toEqual([]);
}, 30_000);

it("publishes every internal reader dependency from committed worker writes without a Cards scan", async () => {
  const f = await fixture();
  seed(f);
  const owner = f.owner;
  f.db
    .prepare(
      "INSERT INTO artifacts(id,owner_id,conversation_id,run_id,title,kind,content,created_at,updated_at) VALUES('artifact',?,'thread','run','Output','markdown','Body',1,1)",
    )
    .run(owner);
  f.db
    .prepare(
      "INSERT INTO runs(id,owner_id,input,state,idempotency_key,created_at,updated_at) VALUES('child',?,'Child','queued','child-key',1,1)",
    )
    .run(owner);
  const stream = watch(f);
  await expect.poll(() => stream.frames.length).toBeGreaterThan(0);
  // These tables have no public mutation endpoint. The worker/adapter ingress
  // commits them on another SQLite connection; exercise that production write
  // boundary while observing only the real compiled server's v3 transport.
  const rows: [
    string,
    Record<string, string | number | null>,
    string,
    string,
    string,
  ][] = [
    [
      "agent_checkpoints",
      {
        run_id: "run",
        message_id: "message",
        artifact_id: "artifact",
        history: "[]",
      },
      "run",
      "run",
      "results",
    ],
    [
      "delegations",
      {
        parent_run_id: "run",
        call_id: "delegation",
        child_run_id: "child",
        arguments: "{}",
      },
      "run",
      "run",
      "feed",
    ],
    [
      "memory_receipts",
      { run_id: "run", mode: "off", sources: "[]", tokens: 0, created_at: 1 },
      "run",
      "run",
      "runs",
    ],
    [
      "native_dispatch",
      {
        run_id: "run",
        generation: "generation",
        digest: "digest",
        state: "accepted",
        created_at: 1,
      },
      "run",
      "run",
      "decisions",
    ],
    [
      "native_decisions",
      {
        id: "decision",
        run_id: "run",
        conversation_id: "thread",
        generation: "generation",
        native_id: "native",
        request: "{}",
        created_at: 1,
      },
      "decision",
      "decision",
      "approvals",
    ],
    [
      "personal_decisions",
      {
        id: "native:decision",
        owner_id: owner,
        run_id: "run",
        native_decision_id: "decision",
        kind: "answer",
        response: "{}",
        created_at: 1,
      },
      "collection",
      "decisions",
      "decisions",
    ],
    [
      "run_traces",
      {
        owner_id: owner,
        run_id: "run",
        trace_key: "tool",
        kind: "tool",
        title: "Tool",
        created_at: 1,
      },
      "run",
      "run",
      "activities",
    ],
    [
      "run_checkouts",
      {
        id: "checkout",
        owner_id: owner,
        run_id: "run",
        agent_id: "agent",
        conversation_id: "thread",
        directory: f.dir,
        source: f.dir,
        branch: "fixture",
        start_head: "a".repeat(40),
        start_dirty: 0,
        start_untracked: 0,
        started_at: 1,
        state: "started",
      },
      "run",
      "run",
      "results",
    ],
    [
      "run_verifications",
      {
        id: "verification",
        owner_id: owner,
        run_id: "run",
        conversation_id: "thread",
        kind: "test",
        tools: "[]",
        command: "npm test",
        status: "passed",
        observed_at: 1,
      },
      "run",
      "run",
      "results",
    ],
    [
      "agent_activities",
      {
        owner_id: owner,
        scope: "thread",
        activity_key: "settings",
        conversation_id: "thread",
        kind: "settings",
        record: "{}",
        sequence: 1,
        created_at: 1,
        updated_at: 1,
      },
      "conversation",
      "thread",
      "activities",
    ],
    [
      "run_steering",
      {
        id: "steering",
        owner_id: owner,
        run_id: "run",
        message_id: "message",
        idempotency_key: "steer-key",
        request: "{}",
        created_at: 1,
      },
      "run",
      "run",
      "runs",
    ],
    [
      "objects",
      {
        id: "object",
        owner_id: owner,
        name: "File",
        mime: "text/plain",
        bytes: "Body",
        created_at: 1,
      },
      "collection",
      "saved",
      "results",
    ],
    [
      "artifact_objects",
      {
        artifact_id: "artifact",
        owner_id: owner,
        run_id: "run",
        call_id: "file",
        object_key: "object",
        mime: "text/plain",
        size: 4,
        checksum: "hash",
      },
      "artifact",
      "artifact",
      "results",
    ],
    [
      "artifact_bookmarks",
      { artifact_id: "artifact", saved_at: 1 },
      "artifact",
      "artifact",
      "saved",
    ],
    [
      "agent_threads",
      {
        id: "mail-thread",
        owner_id: owner,
        scope: "direct",
        subject: "Subject",
        created_by: "agent",
        created_at: 1,
        updated_at: 1,
      },
      "mail_thread",
      "mail-thread",
      "mail",
    ],
    [
      "agent_thread_members",
      {
        thread_id: "mail-thread",
        agent_id: "agent",
        conversation_id: "thread",
      },
      "mail_thread",
      "mail-thread",
      "mail",
    ],
    [
      "agent_mail",
      {
        id: "mail",
        owner_id: owner,
        thread_id: "mail-thread",
        kind: "message",
        sender_agent_id: "agent",
        recipient_agent_id: "worker",
        body: "Hello",
        idempotency_key: "mail-key",
        request: "{}",
        state: "held",
        created_at: 1,
      },
      "mail_thread",
      "mail-thread",
      "mail",
    ],
    [
      "pr_watches",
      {
        id: "watch",
        owner_id: owner,
        conversation_id: "thread",
        agent_id: "agent",
        repo_owner: "fixture",
        repo_name: "repo",
        number: 1,
        created_at: 1,
        updated_at: 1,
      },
      "conversation",
      "thread",
      "pulls",
    ],
    [
      "pr_watch_deliveries",
      { watch_id: "watch", run_id: "run", created_at: 1 },
      "conversation",
      "thread",
      "pulls",
    ],
    [
      "pr_watch_seen",
      { watch_id: "watch", kind: "comment", item_id: 1 },
      "conversation",
      "thread",
      "pulls",
    ],
    [
      "feed_sources",
      {
        id: "custom",
        owner_id: owner,
        url: "https://example.com/rss",
        title: "Feed",
        home: "example.com",
        category: "News",
        kind: "post",
        color: "blue",
        created_at: 1,
      },
      "social",
      "custom",
      "social",
    ],
    [
      "feed_stories",
      {
        feed_id: "custom",
        story_id: "story",
        url: "https://example.com/story",
        title: "Story",
        story: "{}",
        first_seen_at: 1,
        fetched_at: 1,
      },
      "collection",
      "social",
      "social",
    ],
    [
      "feed_state",
      { feed_id: "custom", title: "Feed", fetched_at: 1 },
      "collection",
      "social",
      "social",
    ],
    [
      "feed_watches",
      {
        id: "feed-watch",
        owner_id: owner,
        query: "Story",
        created_at: 1,
        since_at: 1,
      },
      "collection",
      "social",
      "social",
    ],
    [
      "feed_watch_hits",
      {
        watch_id: "feed-watch",
        feed_id: "custom",
        story_id: "story",
        matched_at: 1,
      },
      "collection",
      "social",
      "social",
    ],
  ];
  for (const [table, row, kind, identity, collection] of rows) {
    const before = (
      f.db
        .prepare("SELECT last_event_id FROM change_watermark WHERE owner_id=?")
        .get(owner) as any
    ).last_event_id;
    f.db
      .transaction(() => {
        f.db
          .prepare(
            `INSERT INTO ${table}(${Object.keys(row).join(",")}) VALUES(${Object.keys(
              row,
            )
              .map(() => "?")
              .join(",")})`,
          )
          .run(...Object.values(row));
        // The log and compatibility projections are visible in this same commit.
        expect(
          (
            f.db
              .prepare(
                "SELECT last_event_id FROM change_watermark WHERE owner_id=?",
              )
              .get(owner) as any
          ).last_event_id,
          table,
        ).toBeGreaterThan(before);
      })
      .immediate();
    await expect
      .poll(
        () =>
          stream
            .events()
            .some(
              ({ id, event }) =>
                id > before &&
                event.type === "invalidate" &&
                event.subject?.kind === kind &&
                event.subject.id === identity &&
                eventScopes(event).some(
                  (scope) =>
                    scope.kind === "collection" && scope.id === collection,
                ),
            ),
        { timeout: 2000, message: table },
      )
      .toBe(true);
  }
  const mutate = async (
    sql: string,
    kind: string,
    identity: string,
    collection: string,
  ) => {
    const before = (
      f.db
        .prepare("SELECT last_event_id FROM change_watermark WHERE owner_id=?")
        .get(owner) as any
    ).last_event_id;
    f.db.exec(sql);
    await expect
      .poll(() =>
        stream
          .events()
          .some(
            ({ id, event }) =>
              id > before &&
              event.subject?.kind === kind &&
              event.subject.id === identity &&
              eventScopes(event).some((scope) => scope.id === collection),
          ),
      )
      .toBe(true);
  };
  await mutate(
    "UPDATE artifact_publications SET sequence=sequence+100 WHERE artifact_id='artifact'",
    "artifact",
    "artifact",
    "results",
  );
  await mutate(
    "UPDATE personal_decisions SET response='{\"q\":[\"Recorded\"]}' WHERE id='native:decision'",
    "collection",
    "decisions",
    "decisions",
  );
  await mutate(
    "DELETE FROM native_decisions WHERE id='decision'",
    "collection",
    "decisions",
    "decisions",
  );
  expect(
    f.db
      .prepare("SELECT 1 FROM personal_decisions WHERE id='native:decision'")
      .get(),
  ).toBeUndefined();
  const project = await f.request("/api/folders", {
    headers: f.browser,
    body: { name: "New root", kind: "project" },
  });
  const projectId = (await project.json()).id;
  const beforeProject = stream.frames.at(-1)!.cursor;
  f.db
    .prepare(
      "INSERT INTO workspace_projects(owner_id,project_id) VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET project_id=excluded.project_id",
    )
    .run(owner, projectId);
  await expect
    .poll(() =>
      stream
        .events()
        .some(
          ({ id, event }) =>
            id > beforeProject &&
            event.subject?.kind === "collection" &&
            event.subject.id === "metadata",
        ),
    )
    .toBe(true);
  await mutate(
    "DELETE FROM agent_thread_members WHERE thread_id='mail-thread'",
    "collection",
    "mail",
    "mail",
  );
  // A read-only observer that is not a follower receives no shared Social data.
  f.db
    .prepare(
      "INSERT INTO feed_subscriptions VALUES('other-owner','unrelated',1,NULL)",
    )
    .run();
  const foreignBefore = f.db
    .prepare(
      "SELECT last_event_id FROM change_watermark WHERE owner_id='other-owner'",
    )
    .get();
  await mutate(
    "UPDATE feed_stories SET title='Changed' WHERE feed_id='custom'",
    "collection",
    "social",
    "social",
  );
  expect(
    f.db
      .prepare(
        "SELECT last_event_id FROM change_watermark WHERE owner_id='other-owner'",
      )
      .get(),
  ).toEqual(foreignBefore);
  expect(f.db.pragma("foreign_key_check")).toEqual([]);
}, 20_000);
