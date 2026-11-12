import express from "express";
import { afterAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import {
  workspaceApi,
  workspaceRoutes,
  type RouteContract,
} from "../src/shared/workspace-api";
import { readRoute } from "../src/client/workspace-api";

const directory = mkdtempSync(join(tmpdir(), "loop-github-contracts-"));
process.env.LOOP_DATA_DIR = directory;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { app: productionApp } = await import("../src/server/index");
const { nativeSessions } = await import("../src/server/native-sessions");
const { OWNER: owner } = await import("../src/server/workspace-identity");
const { closeExecution } = await import("../src/server/execution-client");
const { createAgent } = await import("../src/server/domain");
const { submit } = await import("../src/server/agent-runtime");
const { saveArtifact } = await import("../src/server/artifacts");
const { seal } = await import("../src/server/secrets");
const { createGithubClient, withGithubClient } =
  await import("../src/server/github-api");
const { watchCreatedPullRequest } = await import("../src/server/pr-watches");
const { fakeGithub, FIRST_HEAD } = await import(
  resolve("scripts/helpers/fake-github.mjs")
);
const github = await fakeGithub();
let failWrite = false;
let attemptedWrites = 0;
let suppliedSecrets = 0;
function privateFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(privateFields);
  if (value && typeof value === "object") {
    suppliedSecrets++;
    return {
      ...Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, privateFields(item)]),
      ),
      token: "private-github-token",
      access_token: "private-access-token",
      credentials: { secret: "private-credentials" },
    };
  }
  return value;
}
const githubClient = createGithubClient({
  fetch: async (url, init) => {
    if (init.method && init.method !== "GET" && !url.endsWith("/graphql")) {
      attemptedWrites++;
      if (failWrite) throw new TypeError("fixture disconnect after dispatch");
    }
    const response = await fetch(url, init);
    if (!response.headers.get("content-type")?.includes("application/json"))
      return response;
    return Response.json(privateFields(await response.json()), {
      status: response.status,
      headers: response.headers,
    });
  },
  base: github.base,
});
const app = express();
app.use((_req, _res, next) => withGithubClient(githubClient, next));
app.use(productionApp);
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
    /private-(?:github|access|credentials|column|connection)/,
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
function connectGithub(who: string) {
  db.prepare(
    "INSERT INTO mcp_connections(id,owner_id,name,url,secret,status,metadata,created_at) VALUES(?,?,'GitHub','https://api.githubcopilot.com/mcp/',?,'connected','{}',?)",
  ).run(
    id(),
    who,
    seal(
      JSON.stringify({ type: "bearer", token: "private-github-token" }),
      who,
    ),
    now(),
  );
}
const agent = agentFor(owner),
  otherAgent = agentFor("other-owner");
const run = submit(owner, {
  agentId: agent.id,
  input: "Contract watch",
  idempotencyKey: id(),
});
connectGithub(owner);
connectGithub("other-owner");
const otherRun = submit("other-owner", {
  agentId: otherAgent.id,
  input: "Other owner",
  idempotencyKey: id(),
});
const otherPrWatch = watchCreatedPullRequest(otherRun, {
  owner: "acme",
  repo: "api",
  number: 64,
})!;
// Use the production artifact writer and projected GitHub detail, not a copied
// browser response, to create the stored PR card consumed by startWatch.
const detail = await request("/github/pulls/acme/api/64");
valid(workspaceApi.githubPullDetail, detail);
const artifact = saveArtifact(owner, {
  title: "GitHub card",
  kind: "github_pr",
  agent: agent.id,
  conversation: run.conversation_id,
  run: run.id,
  content: JSON.stringify({
    type: "github_pull_requests",
    tool: "pull_request_read",
    fetchedAt: now(),
    pulls: [detail.data],
  }),
  role: "trace",
});
const watchInput = {
  artifactId: artifact,
  owner: "acme",
  repo: "api",
  number: 64,
};
const prWatch = await request("/pr-watches", watchInput);
valid(workspaceApi.prWatchCreate, prWatch);
expect(prWatch.data.since_at).toEqual(expect.any(Number));
for (const key of ["comment_cursor", "review_comment_cursor", "review_cursor"])
  expect(prWatch.data).not.toHaveProperty(key);
db.exec("ALTER TABLE pr_watches ADD COLUMN private_column TEXT;");
db.prepare("UPDATE pr_watches SET private_column='private-column-value'").run();
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await github.close();
  await closeExecution();
  await nativeSessions.close();
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

type Case = [keyof typeof workspaceRoutes, string, unknown?, unknown?];
it.each([64, "64"])(
  "typed GitHub reader sends a validated numeric path parameter (%s) over HTTP",
  async (number) => {
    const nativeFetch = globalThis.fetch;
    const dispatched: string[] = [];
    const browser = new EventTarget();
    const clocks: unknown[] = [];
    browser.addEventListener("loop-workspace-clock", (event) =>
      clocks.push((event as CustomEvent).detail),
    );
    vi.stubGlobal("window", browser);
    vi.stubGlobal("location", { search: "", href: origin + "/" });
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof input === "string" && input.startsWith("/")) {
        dispatched.push(input);
        return nativeFetch(origin + input, init);
      }
      return nativeFetch(input, init);
    });
    try {
      const input = { params: { owner: "acme", repo: "api", number } };
      const result = await readRoute(
        workspaceApi.githubPullDetail,
        input,
        "",
        new AbortController().signal,
      );
      expect(result.number).toBe(64);
      expect(result.headSha).toBe(FIRST_HEAD);
      expect(dispatched).toEqual(["/api/github/pulls/acme/api/64"]);
      expect(clocks).toEqual([expect.objectContaining({ source: "" })]);
      await expect(
        readRoute(
          workspaceApi.githubPullDetail,
          { params: { ...input.params, number: 0 } },
          "",
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ status: 400 });
      expect(dispatched).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  },
);
const cases: Case[] = [
  ["prWatchList", "/pr-watches"],
  ["prWatchCreate", "/pr-watches", watchInput, { ...watchInput, number: 0 }],
  ["githubPullList", "/github/pulls?filter=authored"],
  ["githubPullDetail", "/github/pulls/acme/api/64"],
  ["githubPullFiles", `/github/pulls/acme/api/64/files?head=${FIRST_HEAD}`],
  [
    "githubPullCommitFiles",
    `/github/pulls/acme/api/64/commits/${FIRST_HEAD}/files`,
  ],
  [
    "githubPullReview",
    "/github/pulls/acme/api/64/reviews",
    { event: "approve", headSha: FIRST_HEAD },
    { event: "approve" },
  ],
  [
    "githubPullComment",
    "/github/pulls/acme/api/64/comments",
    { body: "Read this head", headSha: FIRST_HEAD },
    { body: "Missing head" },
  ],
];
for (const [name, path, body, invalidBody] of cases)
  it(`${name} validates actual HTTP input and projects production rows`, async () => {
    const contract = workspaceApi[name];
    expect(
      invalidBody === undefined
        ? await invalid(path, contract.method)
        : await request(path, invalidBody, contract.method),
    ).toMatchObject(bad);
    const before = attemptedWrites;
    const result = await request(path, body, contract.method);
    valid(contract, result);
    if (name === "githubPullReview" || name === "githubPullComment")
      expect(attemptedWrites - before).toBe(1);
    if (name === "prWatchList")
      expect(
        result.data.watches.some(
          (w: { id: string }) => w.id === otherPrWatch.id,
        ),
      ).toBe(false);
  });
it("prWatchResume preserves watch identity and denies another owner", async () => {
  const path = `/pr-watches/${prWatch.data.id}/resume`;
  expect(await invalid(path, "POST")).toMatchObject(bad);
  expect(
    (await request(`/pr-watches/${otherPrWatch.id}/resume`, {})).status,
  ).toBe(404);
  db.prepare(
    "UPDATE pr_watches SET state='paused',error='fixture pause' WHERE id=?",
  ).run(prWatch.data.id);
  valid(workspaceApi.prWatchResume, await request(path, {}));
  expect(
    db.prepare("SELECT state FROM pr_watches WHERE id=?").get(prWatch.data.id),
  ).toEqual({ state: "watching" });
});
it("prWatchDelete stops only this owner's watch", async () => {
  const path = `/pr-watches/${prWatch.data.id}`;
  expect(await invalid(path, "DELETE")).toMatchObject(bad);
  expect(
    (await request(`/pr-watches/${otherPrWatch.id}`, undefined, "DELETE"))
      .status,
  ).toBe(404);
  valid(workspaceApi.prWatchDelete, await request(path, undefined, "DELETE"));
  expect(
    db.prepare("SELECT state FROM pr_watches WHERE id=?").get(prWatch.data.id),
  ).toEqual({ state: "stopped" });
});
it("githubPullFile streams the pinned repository file with its attachment policy", async () => {
  const path = `/github/pulls/acme/api/64/file?head=${FIRST_HEAD}&path=README.md`;
  expect(await invalid(path)).toMatchObject(bad);
  expect(
    await request(
      `/github/pulls/acme/api/64/file?head=${FIRST_HEAD}&path=../secret`,
    ),
  ).toMatchObject(bad);
  const response = await fetch(origin + "/api" + path);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/plain");
  expect(response.headers.get("content-security-policy")).toContain("sandbox");
  expect(await response.text()).toContain("Run `npm start`");
});
it("GitHub comments reject a moved head before dispatch and never retry an uncertain write", async () => {
  const path = "/github/pulls/acme/api/64/comments";
  let before = attemptedWrites;
  github.state.head = "b".repeat(40);
  expect(
    (await request(path, { body: "Old head", headSha: FIRST_HEAD })).status,
  ).toBe(409);
  expect(attemptedWrites).toBe(before);
  github.state.head = FIRST_HEAD;
  failWrite = true;
  try {
    expect(
      (await request(path, { body: "Uncertain", headSha: FIRST_HEAD })).status,
    ).toBe(502);
  } finally {
    failWrite = false;
  }
  expect(attemptedWrites - before).toBe(1);
});
it("githubPullMerge requires the displayed head and makes one pinned write", async () => {
  const path = "/github/pulls/acme/api/64/merge";
  expect(await request(path, { method: "squash" })).toMatchObject(bad);
  const before = attemptedWrites;
  const result = await request(path, { method: "squash", headSha: FIRST_HEAD });
  valid(workspaceApi.githubPullMerge, result);
  expect(attemptedWrites - before).toBe(1);
  expect(github.state.writes.at(-1).body.sha).toBe(FIRST_HEAD);
  expect(suppliedSecrets).toBeGreaterThan(0);
  // Conversation comments on a merged PR still work when its head is unchanged.
  valid(
    workspaceApi.githubPullComment,
    await request("/github/pulls/acme/api/64/comments", {
      body: "Follow-up",
      headSha: FIRST_HEAD,
    }),
  );
});
