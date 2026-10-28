import { afterAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import {
  workspaceApi,
  workspaceRoutes,
  type RouteContract,
} from "../src/shared/workspace-api";

const directory = mkdtempSync(join(tmpdir(), "loop-social-contracts-"));
process.env.LOOP_DATA_DIR = directory;
process.env.LOOP_PROFILE = "companion";
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { app } = await import("../src/server/index");
const { nativeSessions, OWNER: owner } =
  await import("../src/server/native-sessions");
const { closeExecution } = await import("../src/server/execution-client");
const { createAgent } = await import("../src/server/domain");
const { submit } = await import("../src/server/agent-runtime");
const { seal } = await import("../src/server/secrets");
const { withNewsFixture } = await import("../src/server/news");
const { importOpml } = await import("../src/server/feed-sources");
const { saveWatch } = await import("../src/server/feed-watches");
const { saveDigest } = await import("../src/server/feed-digests");
const picture = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const restoreNews = withNewsFixture(async (url) =>
  url.endsWith("picture.png")
    ? new Response(picture, { headers: { "content-type": "image/png" } })
    : new Response(
        `<rss version="2.0"><channel><title>Contract feed</title><link>https://public.example/</link><item><guid>contract-story</guid><title>Contract news</title><link>https://public.example/story</link><description>Schema boundary story</description><enclosure url="https://public.example/picture.png" type="image/png"/></item></channel></rss>`,
      ),
);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
async function request(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
) {
  const response = await fetch(origin + "/api" + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : undefined };
}
async function invalid(path: string, method = "GET") {
  const payload = method === "GET" ? "{}" : "{";
  return new Promise<{ status: number; data: unknown }>((resolve, reject) => {
    const req = httpRequest(
      origin + "/api" + path,
      {
        method,
        headers: {
          "content-type": "application/json",
          "content-length": String(payload.length),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            data: JSON.parse(Buffer.concat(chunks).toString()),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}
const bad = { status: 400, data: { error: expect.any(String) } };
function valid(
  contract: RouteContract,
  result: Awaited<ReturnType<typeof request>>,
) {
  expect(result.status, JSON.stringify(result.data)).toBe(
    contract.status ?? 200,
  );
  expect(contract.response.parse(result.data)).toEqual(result.data);
  expect(JSON.stringify(result.data)).not.toMatch(
    /private-(?:column|connection)/,
  );
}
function agentFor(who: string) {
  const connection = id();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,?,'openai','Fixture',?,'connected',?,?)",
  ).run(
    connection,
    who,
    seal("private-connection-key", who),
    JSON.stringify([{ id: "fixture" }]),
    now(),
  );
  return createAgent(who, {
    name: "contract-reader-" + who.slice(0, 8),
    connectionId: connection,
    model: "fixture",
  });
}
const agent = agentFor(owner),
  otherAgent = agentFor("other-owner");
const run = submit(owner, {
  agentId: agent.id,
  input: "Contract watch",
  idempotencyKey: id(),
});
const otherRun = submit("other-owner", {
  agentId: otherAgent.id,
  input: "Other owner",
  idempotencyKey: id(),
});
const source = await request(
  "/social/sources",
  { url: "https://public.example/contract-feed" },
  "PUT",
);
valid(workspaceApi.socialSourceAdd, source);
await request("/social/feeds/hackernews", undefined, "PUT");
const social = await request("/social?wait=1");
valid(workspaceApi.socialList, social);
const story = social.data.stories[0].id as string;
const watch = saveWatch(owner, { query: "Contract" });
const otherWatch = saveWatch("other-owner", { query: "other-only-watch" });
const digestInput = {
  agentId: agent.id,
  conversationId: run.conversation_id,
  minuteOfDay: 480,
  zone: "UTC",
};
const digest = saveDigest(owner, digestInput);
const otherDigest = saveDigest("other-owner", {
  ...digestInput,
  agentId: otherAgent.id,
  conversationId: otherRun.conversation_id,
});
importOpml(
  "other-owner",
  '<opml><body><outline xmlUrl="https://private.example/owner-feed"/></body></opml>',
);
db.exec(
  "ALTER TABLE feed_watches ADD COLUMN private_column TEXT; ALTER TABLE feed_digests ADD COLUMN private_column TEXT;",
);
for (const table of ["feed_watches", "feed_digests"])
  db.prepare(`UPDATE ${table} SET private_column='private-column-value'`).run();
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  restoreNews();
  await closeExecution();
  await nativeSessions.close();
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

type Case = [keyof typeof workspaceRoutes, string, unknown?, unknown?];
const cases: Case[] = [
  ["socialUnread", "/social/unread"],
  ["socialList", "/social?wait=1"],
  ["socialSearch", "/social/search?q=Contract"],
  ["socialMutes", "/social/mutes"],
  ["socialMute", "/social/mutes", { phrase: "unmatched-word" }, { phrase: 1 }],
  [
    "socialUnmute",
    "/social/mutes",
    { phrase: "unmatched-word" },
    { phrase: 1 },
  ],
  ["socialRead", "/social/read", { stories: [story] }, { stories: [1] }],
  ["socialUnreadSet", "/social/read", { stories: [story] }, { stories: [1] }],
  ["socialDismiss", "/social/dismiss", { stories: [story] }, { stories: [1] }],
  ["socialRestore", "/social/dismiss", { stories: [story] }, { stories: [1] }],
  ["socialPreferences", "/social/preferences"],
  [
    "socialPreferencesUpdate",
    "/social/preferences",
    { images: true },
    { agent_access: "true" },
  ],
  ["socialReadAll", "/social/read-all", {}, { feed: 1 }],
  ["socialFeeds", "/social/feeds"],
  [
    "socialSourceDiscover",
    "/social/sources/discover",
    { url: source.data.url },
    { url: "http://127.0.0.1/feed" },
  ],
  [
    "socialSourceAdd",
    "/social/sources",
    { url: source.data.url },
    { url: "http://127.0.0.1/feed" },
  ],
  ["socialSourceDelete", `/social/sources/${source.data.id}`],
  [
    "socialOpmlImport",
    "/social/opml",
    {
      opml: '<opml><body><outline xmlUrl="https://public.example/imported"/></body></opml>',
    },
    { opml: "x".repeat(1_000_001) },
  ],
  ["socialFeedAdd", "/social/feeds/hackernews"],
  ["socialFeedDelete", "/social/feeds/hackernews"],
  ["socialWatches", "/social/watches"],
  [
    "socialWatchCreate",
    "/social/watches",
    { query: "Contract" },
    { query: "" },
  ],
  [
    "socialWatchPreview",
    "/social/watches/preview",
    { query: "Contract" },
    { query: "" },
  ],
  [
    "socialWatchUpdate",
    `/social/watches/${watch.id}`,
    { query: "Contract", enabled: false },
    { query: "" },
  ],
  ["socialWatchDelete", `/social/watches/${watch.id}`],
  ["socialDigests", "/social/digests"],
  [
    "socialDigestCreate",
    "/social/digests",
    digestInput,
    { ...digestInput, minuteOfDay: 1440 },
  ],
  [
    "socialDigestUpdate",
    `/social/digests/${digest.id}`,
    { ...digestInput, enabled: false },
    { ...digestInput, zone: "not/a-zone" },
  ],
  ["socialDigestDelete", `/social/digests/${digest.id}`],
];
for (const [name, path, body, invalidBody] of cases)
  it(`${name} validates actual HTTP input and projects production rows`, async () => {
    const contract = workspaceApi[name];
    expect(
      invalidBody === undefined
        ? await invalid(path, contract.method)
        : await request(path, invalidBody, contract.method),
    ).toMatchObject(bad);
    const result = await request(path, body, contract.method);
    valid(contract, result);
    if (name === "socialWatches")
      expect(
        result.data.watches.some((w: { id: string }) => w.id === otherWatch.id),
      ).toBe(false);
    if (name === "socialDigests")
      expect(
        result.data.digests.some(
          (d: { id: string }) => d.id === otherDigest.id,
        ),
      ).toBe(false);
  });
it("socialImage preserves private streaming headers and ownership", async () => {
  // The catalog feed remains in storage after unfollowing; follow it again.
  await request("/social/feeds/hackernews", undefined, "PUT");
  const rows = await request("/social?wait=1");
  const imageStory = rows.data.stories.find(
    (s: { image: string | null }) => s.image,
  );
  expect(imageStory).toBeDefined();
  const path = "/social/image?story=" + encodeURIComponent(imageStory.id);
  expect(await invalid(path)).toMatchObject(bad);
  const response = await fetch(origin + "/api" + path);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("image/png");
  expect(response.headers.get("cache-control")).toContain("private");
  expect(response.headers.get("content-security-policy")).toContain("sandbox");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(picture);
  expect(
    (
      await request(
        "/social/image?story=" + encodeURIComponent("unknown:story"),
      )
    ).status,
  ).toBe(404);
});
it("socialOpmlExport returns only this owner's subscriptions as an XML download", async () => {
  expect(await invalid("/social/opml")).toMatchObject(bad);
  const response = await fetch(origin + "/api/social/opml");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/xml");
  expect(response.headers.get("content-disposition")).toContain(
    "loop-feeds.opml",
  );
  const xml = await response.text();
  expect(xml).toContain("public.example/imported");
  expect(xml).not.toContain("private.example");
});
