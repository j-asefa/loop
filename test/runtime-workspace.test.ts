import type { Connection } from "../src/shared/types";
import { it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import express from "express";

const dir = mkdtempSync(join(tmpdir(), "loop-workspace-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { seal } = await import("../src/server/secrets");
const { owned } = await import("../src/server/domain");
function subscriptionConnection(provider: "codex" | "anthropic", metadata: object = {}) {
  db.prepare("INSERT INTO connections(id,owner_id,provider,label,secret,status,metadata,created_at) VALUES('fixture','alice',?,'Fixture','','connected',?,?) ON CONFLICT(id) DO UPDATE SET provider=excluded.provider,metadata=excluded.metadata")
    .run(provider, JSON.stringify({ authMode: "subscription", ...metadata }), now());
  return owned<Connection>("connections", "fixture", "alice");
}
const { runtimeGithubCredential } =
  await import("../src/server/runtime-github");
const { runtimeWorkspaceKey, subscriptionStream } =
  await import("../src/server/subscriptions");
const { cleanupMergedWorkspaces } =
  await import("../src/server/workspace-cleanup");
const { githubEnvironment } = await import(resolve("runtime/workspace.ts"));
const token = "fixture-github-secret";
function preference(owner = "alice", mode = "allow") {
  db.prepare(
    "INSERT OR REPLACE INTO mcp_preferences(owner_id,approval_mode) VALUES(?,?)",
  ).run(owner, mode);
}
function github(
  options: {
    owner?: string;
    url?: string;
    status?: string;
    auth?: object;
  } = {},
) {
  const key = id(),
    owner = options.owner || "alice";
  db.prepare(
    "INSERT INTO mcp_connections(id,owner_id,name,url,secret,status,created_at) VALUES(?,?,'GitHub',?,?,?,?)",
  ).run(
    key,
    owner,
    options.url || "https://api.githubcopilot.com/mcp/",
    seal(JSON.stringify(options.auth || { type: "bearer", token }), owner),
    options.status || "connected",
    now(),
  );
  return key;
}
const app = express();
const requests: any[] = [];
app.use(express.json());
app.post("/runtime", (req, res) => {
  requests.push(req.body);
  if (req.body.action === "cleanup") {
    res.json({ results: [] });
    return;
  }
  res.type("application/x-ndjson").end(
    [
      {
        chunk: {
          text: "Answer " + (req.body.githubToken || "no credential"),
        },
      },
      {
        chunk: {
          trace: {
            id: "1",
            kind: "tool",
            title: "Git result",
            content: `credential=${req.body.githubToken || "none"}`,
          },
        },
      },
      { done: true },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n",
  );
});
let server: ReturnType<typeof app.listen>;
beforeAll(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  process.env.LOOP_RUNTIME_URL =
    "http://127.0.0.1:" + (server.address() as any).port;
  process.env.LOOP_ALLOWED_RUNTIME_ORIGINS = process.env.LOOP_RUNTIME_URL;
  process.env.LOOP_RUNTIME_TOKEN = "fixture-runtime-authentication-token";
});
afterEach(() => {
  db.exec(
    "DELETE FROM agents; DELETE FROM connections; DELETE FROM mcp_connections; DELETE FROM mcp_preferences; DELETE FROM runtime_hosts",
  );
  requests.length = 0;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

it("keeps one agent's workspace stable and separates agents and owners", () => {
  const key = runtimeWorkspaceKey("alice", "agent-1");
  expect(key).toMatch(/^[a-f0-9]{64}$/);
  expect(runtimeWorkspaceKey("alice", "agent-1")).toBe(key);
  expect(runtimeWorkspaceKey("bob", "agent-1")).not.toBe(key);
  expect(runtimeWorkspaceKey("alice", "agent-2")).not.toBe(key);
});
it("only uses the owner's allowed connected official GitHub account", () => {
  const key = github();
  expect(runtimeGithubCredential("alice")).toBeUndefined();
  preference();
  expect(runtimeGithubCredential("alice")).toEqual({ type: "bearer", token });
  preference("bob");
  expect(runtimeGithubCredential("bob")).toBeUndefined();
  db.prepare("UPDATE mcp_connections SET status='disabled' WHERE id=?").run(
    key,
  );
  expect(runtimeGithubCredential("alice")).toBeUndefined();
  db.prepare("UPDATE mcp_connections SET status='connected' WHERE id=?").run(
    key,
  );
  preference("alice", "ask");
  expect(runtimeGithubCredential("alice")).toBeUndefined();
});
it("rejects lookalike hosts and ambiguous accounts, and reads bearer/header/OAuth auth", () => {
  preference();
  for (const url of [
    "https://api.githubcopilot.com.evil.test/mcp/",
    "https://evil@api.githubcopilot.com/mcp/",
    "http://api.githubcopilot.com/mcp/",
    "https://api.githubcopilot.com:444/mcp/",
    "https://api.githubcopilot.com/unrelated",
    "https://github.com/mcp/",
  ])
    github({ url });
  expect(runtimeGithubCredential("alice")).toBeUndefined();
  for (const auth of [
    { type: "bearer", token },
    { type: "headers", headers: { AUTHORIZATION: "Bearer " + token } },
    {
      type: "oauth",
      tokens: { access_token: token, refresh_token: "never-forward-refresh" },
    },
  ]) {
    const key = github({ auth });
    expect(runtimeGithubCredential("alice")).toEqual({ type: "bearer", token });
    db.prepare("DELETE FROM mcp_connections WHERE id=?").run(key);
  }
  github();
  github({ auth: { type: "bearer", token: "different-account" } });
  expect(runtimeGithubCredential("alice")).toBeUndefined();
});
it("forwards auth outside model context only to managed runtimes and redacts all returned chunks", async () => {
  preference();
  github();
  const workspaceKey = runtimeWorkspaceKey("alice", "agent");
  const input = {
    model: "fixture",
    instructions: "Be clear",
    messages: [{ role: "user" as const, content: "Review the PR" }],
    signal: new AbortController().signal,
    workspaceKey,
  };
  for (const provider of ["codex", "anthropic"] as const) {
    const connection = subscriptionConnection(provider);
    const chunks = [];
    for await (const chunk of subscriptionStream(connection, input))
      chunks.push(chunk);
    const request = requests.at(-1);
    expect(request.githubToken).toBe(token);
    expect(request.input.workspaceKey).toBe(workspaceKey);
    expect(JSON.stringify(request.input)).not.toContain(token);
    expect(JSON.stringify(chunks)).not.toContain(token);
    expect(chunks[0]).toEqual({ text: "Answer [redacted]" });
    expect(chunks[1].trace?.content).toContain("[redacted]");
  }
  db.prepare(
    "INSERT INTO runtime_hosts(id,owner_id,name,url,secret,kind,created_at) VALUES('native','alice','Native',?,?,'native-host',?)",
  ).run(
    process.env.LOOP_RUNTIME_URL,
    seal(process.env.LOOP_RUNTIME_TOKEN!, "alice"),
    now(),
  );
  for (const metadata of [{ runtimeHostId: "native" }, {}]) {
    if (!("runtimeHostId" in metadata)) preference("alice", "ask");
    for await (const _chunk of subscriptionStream(
      subscriptionConnection("codex", metadata),
      input,
    )) {
      /* drain */
    }
    expect(requests.at(-1)).not.toHaveProperty("githubToken");
  }
});
it("Git credentials are per-process and only returned to HTTPS github.com", () => {
  const env = { ...process.env, ...githubEnvironment(token) };
  const helper = resolve("runtime/git-credential.ts");
  const read = (host: string, protocol = "https", action = "get") =>
    execFileSync(process.execPath, [helper, action], {
      input: `protocol=${protocol}\nhost=${host}\n\n`,
      env,
      encoding: "utf8",
    });
  expect(read("github.com")).toBe(
    `username=x-access-token\npassword=${token}\n\n`,
  );
  expect(read("github.com.evil.test")).toBe("");
  expect(read("evil.test")).toBe("");
  expect(read("github.com", "http")).toBe("");
  expect(read("github.com", "https", "store")).toBe("");
  expect(read("github.com", "https", "erase")).toBe("");
  expect(() => githubEnvironment("bad\ntoken")).toThrow();
  expect(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(githubEnvironment(token)).filter(
          ([key]) => key !== "GH_TOKEN",
        ),
      ),
    ),
  ).not.toContain(token);
});

it("maintains owner-scoped managed storage without GitHub and only forwards allowed credentials for PR retirement", async () => {
  preference();
  github();
  preference("bob", "ask");
  github({ owner: "bob", auth: { type: "bearer", token: "bob-secret" } });
  const addConnection = (
    owner: string,
    provider: string,
    metadata: object,
    status = "connected",
  ) => {
    const key = id();
    db.prepare(
      "INSERT INTO connections(id,owner_id,provider,label,secret,status,metadata,created_at) VALUES(?,?,?,'Fixture','',?,?,?)",
    ).run(key, owner, provider, status, JSON.stringify(metadata), now());
    return key;
  };
  const addAgent = (owner: string, connection: string) => {
    const key = id();
    db.prepare(
      "INSERT INTO agents(id,owner_id,name,normalized_name,provider,connection_id,model,created_at) VALUES(?,?,?,?,'codex',?,'fixture',?)",
    ).run(key, owner, key, key, connection, now());
    return key;
  };
  const alice = addConnection("alice", "codex", { authMode: "subscription" });
  const agent = addAgent("alice", alice);
  addAgent("bob", alice); // Even a malformed cross-owner association cannot cross the boundary.
  const bobAgent = addAgent(
    "bob",
    addConnection("bob", "anthropic", { authMode: "subscription" }),
  );
  addAgent("alice", addConnection("alice", "anthropic", {})); // API connection.
  addAgent("alice", addConnection("alice", "codex", { authMode: "subscription" }, "disconnected"));
  const retiredAgent = addAgent(
    "alice",
    addConnection(
      "alice",
      "codex",
      { authMode: "subscription", retiredDirectRuntime: true },
      "disconnected",
    ),
  );
  db.prepare(
    "INSERT INTO runtime_hosts(id,owner_id,name,url,secret,kind,created_at) VALUES('native','alice','Native',?,?,'native-host',?)",
  ).run(
    process.env.LOOP_RUNTIME_URL,
    seal(process.env.LOOP_RUNTIME_TOKEN!, "alice"),
    now(),
  );
  addAgent(
    "alice",
    addConnection("alice", "codex", {
      authMode: "subscription",
      runtimeHostId: "native",
    }),
  );
  await cleanupMergedWorkspaces();
  expect(requests).toHaveLength(3);
  expect(requests[0]).toMatchObject({
    action: "cleanup",
    provider: "codex",
    workspaceKeys: [runtimeWorkspaceKey("alice", agent)],
    githubToken: token,
  });
  expect(requests[1]).toMatchObject({
    action: "cleanup",
    workspaceKeys: [runtimeWorkspaceKey("bob", bobAgent)],
  });
  expect(requests[1]).not.toHaveProperty("githubToken");
  expect(requests[2]).toMatchObject({
    action: "cleanup",
    workspaceKeys: [runtimeWorkspaceKey("alice", retiredAgent)],
    githubToken: token,
  });
  preference("alice", "ask");
  requests.length = 0;
  await cleanupMergedWorkspaces();
  expect(requests).toHaveLength(3);
  expect(
    requests.every((request) => !Object.hasOwn(request, "githubToken")),
  ).toBe(true);
});
