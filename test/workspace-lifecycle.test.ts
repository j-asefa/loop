import { afterAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { runInNewContext } from "node:vm";
import express from "express";
const dir = mkdtempSync(join(tmpdir(), "loop-workspace-lifecycle-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { createAgent } = await import("../src/server/domain");
const { core } = await import("../src/server/core-routes");
const { workspace } = await import("../src/server/workspace-routes");
const { teams, createTeam } = await import("../src/server/teams");
const { notifications, notificationKeys, deliverNotifications, pushEndpoint } =
  await import("../src/server/notifications");
const { saveArtifact } = await import("../src/server/artifacts");
const { feedRevision, feedUpdates } = await import("../src/server/feed");
const { submit } = await import("../src/server/agent-runtime");
const { routeHandle } = await import("../src/server/sharing");
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.locals.owner = req.get("x-owner") || "owner";
  next();
});
app.use(core, workspace, teams, notifications);
app.use((error: any, _req: any, res: any, _next: any) =>
  res.status(error.status || 400).json({ error: error.message }),
);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
async function api(
  path: string,
  body?: unknown,
  method?: string,
  owner = "owner",
) {
  const response = await fetch(
    `http://127.0.0.1:${(server.address() as any).port}${path}`,
    {
      method: method || (body ? "POST" : "GET"),
      headers: { "content-type": "application/json", "x-owner": owner },
      body: body ? JSON.stringify(body) : undefined,
    },
  );
  return { status: response.status, data: await response.json() };
}
const connection = id();
db.prepare(
  "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,?,'openai','Fixture','','connected',?,?)",
).run(connection, "owner", JSON.stringify([{ id: "fixture" }]), now());
const agent = () =>
  createAgent("owner", {
    name: "agent-" + id().slice(0, 8),
    connectionId: connection,
    model: "fixture",
  });
const pin = (artifact: string, value = true) =>
  db
    .prepare("UPDATE artifacts SET pinned=? WHERE id=?")
    .run(Number(value), artifact);
const makeSubscription = () => ({
  endpoint: "https://web.push.apple.com/" + id(),
  keys: {
    p256dh: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString(
      "base64url",
    ),
    auth: randomBytes(16).toString("base64url"),
  },
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

it("Saved is only bookmarked full cards, including feed-archived cards, filtered by team and project", async () => {
  const manager = agent(),
    worker = agent();
  const team = createTeam("owner", {
    name: "Saved team",
    managerId: manager.id,
    members: [worker.id],
  });
  const folder = id();
  db.prepare(
    "INSERT INTO folders(id,owner_id,name,kind,created_at) VALUES(?,?,'Project','project',?)",
  ).run(folder, "owner", now());
  const a = saveArtifact("owner", {
    title: "Chosen card",
    content: "Full **message**",
    agent: manager.id,
    conversation: team.conversation_id,
    folder,
  });
  const unsaved = saveArtifact("owner", {
    title: "Not bookmarked",
    content: "Ordinary automatic result",
  });
  pin(a);
  db.prepare("UPDATE artifacts SET feed_hidden=1 WHERE id=?").run(a);
  const saved = await api(`/feed?saved=1&teams=${team.id}&folder=${folder}`);
  expect(saved.data.items.map((item: any) => item.id)).toEqual([a]);
  expect(saved.data.items[0]).toMatchObject({
    name: manager.name,
    content: "Full **message**",
    pinned: 1,
    team_id: team.id,
  });
  expect((await api("/feed")).data.items.map((item: any) => item.id)).toContain(
    unsaved,
  );
  expect(
    (await api("/feed?saved=1", undefined, undefined, "someone-else")).data
      .items,
  ).toEqual([]);
  const revision = feedRevision("owner");
  pin(a, false);
  expect(
    feedUpdates("owner", { after: revision, through: 0, saved: true }).removed,
  ).toContain(a);
  expect((await api("/feed?saved=1")).data.items).toEqual([]);
});

it("new bookmarks on old results arrive above loaded pages and unsaving removes them incrementally", async () => {
  const old = saveArtifact("owner", {
    title: "Old card",
    content: "Older result",
  });
  const ids = Array.from({ length: 45 }, (_, i) =>
    saveArtifact("owner", { title: "Saved " + i, content: "Full result" }),
  );
  ids.forEach((value) => pin(value));
  const first = (await api("/feed?saved=1")).data;
  expect(first.items).toHaveLength(40);
  const second = (await api(`/feed?saved=1&before=${first.next}`)).data;
  expect(second.items).toHaveLength(5);
  pin(old);
  const updates = (
    await api(
      `/feed/updates?saved=1&after=${first.revision}&through=${first.next}`,
    )
  ).data;
  expect(updates.items.map((item: any) => item.id)).toEqual([old]);
  expect(updates.items[0].cursor).toBeGreaterThan(first.items[0].cursor);
  const revision = updates.revision;
  pin(old, false);
  expect(
    feedUpdates("owner", { after: revision, through: first.next, saved: true })
      .removed,
  ).toContain(old);
});

it("retirement is reversible, owner-scoped, preserves work and history, and rejects new assignments", async () => {
  const a = agent();
  const run = submit("owner", {
    agentId: a.id,
    input: "Accepted before retirement",
    idempotencyKey: id(),
  });
  expect(
    (await api(`/agents/${a.id}`, { retired: true }, "PATCH", "stranger"))
      .status,
  ).toBe(404);
  expect(
    (await api(`/agents/${a.id}`, { retired: true }, "PATCH")).data.retired_at,
  ).toBeGreaterThan(0);
  expect((await api(`/agents/${a.id}`)).data.agent.id).toBe(a.id);
  expect(
    (db.prepare("SELECT state FROM runs WHERE id=?").get(run.id) as any).state,
  ).toBe("queued");
  expect(() =>
    submit("owner", { agentId: a.id, input: "New work", idempotencyKey: id() }),
  ).toThrow("retired");
  expect(() => routeHandle("owner", `@${a.name} New work`)).toThrow("retired");
  expect(() =>
    createTeam("owner", {
      name: "No retired workers",
      managerId: agent().id,
      members: [a.id],
    }),
  ).toThrow("retired");
  expect(
    (await api(`/agents/${a.id}`, { retired: false }, "PATCH")).data.retired_at,
  ).toBe(null);
  expect(
    submit("owner", { agentId: a.id, input: "Restored", idempotencyKey: id() })
      .state,
  ).toBe("queued");
});

it("team deletion is idempotent, removes its filter, and keeps agents and conversations", async () => {
  const a = agent(),
    b = agent();
  const team = createTeam("owner", {
    name: "Delete safely",
    managerId: a.id,
    members: [b.id],
  });
  expect(
    (await api(`/teams/${team.id}`, undefined, "DELETE", "stranger")).status,
  ).toBe(404);
  for (let i = 0; i < 2; i++)
    expect((await api(`/teams/${team.id}`, undefined, "DELETE")).status).toBe(
      200,
    );
  expect((await api("/teams")).data.some((t: any) => t.id === team.id)).toBe(
    false,
  );
  expect(
    (await api(`/conversations/${team.conversation_id}`)).data.conversation
      .team_id,
  ).toBe(null);
  expect((await api(`/agents/${a.id}`)).data.agent.id).toBe(a.id);
});

it("phone subscriptions persist encrypted keys, isolate owners and reject arbitrary webhook URLs", async () => {
  for (const endpoint of [
    "http://web.push.apple.com/x",
    "https://localhost/x",
    "https://127.0.0.1/x",
    "https://web.push.apple.com.attacker.test/x",
    "https://web.push.apple.com:8000/x",
    "https://user@web.push.apple.com/x",
  ])
    expect(pushEndpoint(endpoint)).toBe(false);
  const sub = makeSubscription();
  expect(
    (
      await api("/notifications/subscriptions", {
        ...sub,
        endpoint: "https://localhost/",
      })
    ).status,
  ).toBe(400);
  expect((await api("/notifications/subscriptions", sub)).status).toBe(201);
  expect(
    (await api("/notifications/subscriptions", sub, "POST", "stranger")).status,
  ).toBe(409);
  const stored = db
    .prepare("SELECT subscription FROM push_subscriptions WHERE endpoint=?")
    .get(sub.endpoint) as any;
  expect(stored.subscription).not.toContain(sub.keys.auth);
  expect(
    (await api("/notifications", undefined, undefined, "stranger")).data
      .endpoints,
  ).not.toContain(sub.endpoint);
  expect(notificationKeys()).toEqual(notificationKeys());
  expect((await api("/notifications")).data).not.toHaveProperty("privateKey");
  await api(
    "/notifications/subscriptions",
    { endpoint: sub.endpoint },
    "DELETE",
    "stranger",
  );
  expect((await api("/notifications")).data.endpoints).toContain(sub.endpoint);
  await api(
    "/notifications/subscriptions",
    { endpoint: sub.endpoint },
    "DELETE",
  );
  expect((await api("/notifications")).data.endpoints).not.toContain(
    sub.endpoint,
  );
});

it("only new finished results notify, retries survive failures, expired endpoints are removed", async () => {
  const a = agent();
  saveArtifact("owner", {
    title: "Before subscription",
    content: "History",
    agent: a.id,
  });
  const sub = makeSubscription();
  await api("/notifications/subscriptions", sub);
  expect(db.prepare("SELECT count(*) n FROM push_deliveries").get()).toEqual({
    n: 0,
  });
  const run = submit("owner", {
    agentId: a.id,
    input: "Create a result",
    idempotencyKey: id(),
  });
  // Shaped like a runtime result: in the run's thread, linked to its answer.
  const artifact = saveArtifact("owner", {
    title: "Completed task",
    content: "Done",
    agent: a.id,
    conversation: run.conversation_id,
    run: run.id,
    metadata: { messageId: "answer-1" },
  });
  saveArtifact("owner", {
    title: "Tool output",
    content: "log",
    agent: a.id,
    run: run.id,
    metadata: { tool: "exec" },
  });
  saveArtifact("owner", {
    title: "Intermediate file",
    content: "file",
    agent: a.id,
    run: run.id,
    metadata: { uploaded: true },
  });
  expect(db.prepare("SELECT count(*) n FROM push_deliveries").get()).toEqual({
    n: 0,
  });
  db.prepare("UPDATE runs SET state='completed' WHERE id=?").run(run.id);
  expect(db.prepare("SELECT artifact_id FROM push_deliveries").all()).toEqual([
    { artifact_id: artifact },
  ]);
  const failure = vi.fn(async () => {
    throw { statusCode: 503 };
  });
  await deliverNotifications(failure);
  expect(failure).toHaveBeenCalledTimes(1);
  await deliverNotifications(failure);
  expect(failure).toHaveBeenCalledTimes(1);
  db.prepare("UPDATE push_deliveries SET available_at=0").run();
  const send = vi.fn(async () => ({ statusCode: 201, body: "", headers: {} }));
  await Promise.all([deliverNotifications(send), deliverNotifications(send)]);
  expect(send).toHaveBeenCalledTimes(1);
  const payload = JSON.parse((send.mock.calls[0] as any)[1]);
  // The notification opens the thread at the answer, not a detached result.
  const saved = db
    .prepare(
      "SELECT conversation_id,json_extract(metadata,'$.messageId') message_id FROM artifacts WHERE id=?",
    )
    .get(artifact) as { conversation_id: string; message_id: string | null };
  expect(saved).toEqual({
    conversation_id: run.conversation_id,
    message_id: "answer-1",
  });
  expect(payload).toMatchObject({
    title: `@${a.name} has a new result`,
    url: `/?conversation=${run.conversation_id}&message=answer-1`,
  });
  await deliverNotifications(send);
  expect(send).toHaveBeenCalledTimes(1);
  saveArtifact("owner", {
    title: "Later result",
    content: "Later",
    agent: a.id,
  });
  await deliverNotifications(async () => {
    throw { statusCode: 410 };
  });
  expect((await api("/notifications")).data.endpoints).not.toContain(
    sub.endpoint,
  );
  expect(db.prepare("SELECT count(*) n FROM push_deliveries").get()).toEqual({
    n: 0,
  });
});

it("a background push displays a notification and opens its link on the same origin", async () => {
  const handlers: Record<string, (event: any) => void> = {};
  const showNotification = vi.fn(async () => {}),
    openWindow = vi.fn(async () => {});
  let windows: any[] = [];
  runInNewContext(readFileSync("public/push-events.js", "utf8"), {
    URL,
    self: {
      location: { origin: "https://loop.example" },
      addEventListener: (name: string, fn: any) => {
        handlers[name] = fn;
      },
      registration: { showNotification },
      clients: { matchAll: async () => windows, openWindow },
    },
  });
  let pending: Promise<void> = Promise.resolve();
  handlers.push({
    data: {
      json: () => ({
        title: "Result ready",
        url: "/?artifact=one",
        tag: "one",
      }),
    },
    waitUntil: (promise: Promise<void>) => {
      pending = promise;
    },
  });
  await pending;
  expect(showNotification).toHaveBeenCalledWith(
    "Result ready",
    expect.objectContaining({ tag: "one", data: { url: "/?artifact=one" } }),
  );
  for (const url of ["/?artifact=one", "https://unrelated.example/"]) {
    handlers.notificationclick({
      notification: { close() {}, data: { url } },
      waitUntil: (promise: Promise<void>) => {
        pending = promise;
      },
    });
    await pending;
  }
  expect(openWindow).toHaveBeenCalledExactlyOnceWith(
    "https://loop.example/?artifact=one",
  );
  // With Loop already open, the window is focused and told to open the
  // thread in place; nothing depends on navigate(), which may be missing.
  const focus = vi.fn(async () => {}),
    postMessage = vi.fn();
  windows = [
    { url: "https://unrelated.example/", focus, postMessage },
    { url: "https://loop.example/?page=later", focus, postMessage },
  ];
  handlers.notificationclick({
    notification: {
      close() {},
      data: { url: "/?conversation=c1&message=m1" },
    },
    waitUntil: (promise: Promise<void>) => {
      pending = promise;
    },
  });
  await pending;
  expect(focus).toHaveBeenCalledTimes(1);
  expect(postMessage).toHaveBeenCalledExactlyOnceWith({
    type: "loop-open",
    url: "https://loop.example/?conversation=c1&message=m1",
  });
  expect(openWindow).toHaveBeenCalledTimes(1);
});
