import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import express from "express";
const dir = mkdtempSync(join(tmpdir(), "loop-hosts-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { runtimeHosts, runtimeEndpoint } =
  await import("../src/server/runtime-hosts");
const { subscriptions, runtimeAction, subscriptionStream } =
  await import("../src/server/subscriptions");
const { codexFixture } = await import(
  resolve("tests/helpers/codex-server.mjs")
);
const codex = await codexFixture();
const { core } = await import("../src/server/core-routes");
const { installConfig } = await import("../src/server/mcp/install");
const { Problem } = await import("../src/server/domain");
const requests: any[] = [];
let nextStatus: object | undefined;
let brokerKind = "broker";
const token = "fixture-remote-token-with-at-least-32-characters";
const brokerApp = express();
brokerApp.use(express.json());
brokerApp.use((req, res, next) => {
  if (req.get("authorization") !== "Bearer " + token) {
    res.sendStatus(401);
    return;
  }
  next();
});
brokerApp.get("/health", (_req, res) =>
  res.json({ ok: true, kind: brokerKind }),
);
brokerApp.post("/runtime", (req, res) => {
  requests.push(req.body);
  if (req.body.action === "status" && nextStatus) {
    res.json(nextStatus);
    nextStatus = undefined;
    return;
  }
  if (req.body.action === "login")
    res.json({
      state: "waiting",
      login: { url: "https://claude.ai/oauth/authorize", acceptsCode: true },
    });
  else
    res.json({
      authenticated: true,
      authMode: "subscription",
      models: [{ id: "fixture", name: "Fixture", capabilities: "Test only" }],
    });
});
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.locals.owner = req.get("x-test-owner") || "alice";
  next();
});
app.use(runtimeHosts, subscriptions, core);
app.use((e: Error, _req: any, res: any, _next: any) =>
  res.status(e instanceof Problem ? e.status : 400).json({ error: e.message }),
);
let broker: ReturnType<typeof app.listen>,
  server: ReturnType<typeof app.listen>,
  origin: string,
  brokerUrl: string;
async function listen(app: ReturnType<typeof express>) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  return server;
}
beforeAll(async () => {
  broker = await listen(brokerApp);
  server = await listen(app);
  brokerUrl = "http://127.0.0.1:" + (broker.address() as any).port;
  origin = "http://127.0.0.1:" + (server.address() as any).port;
  process.env.LOOP_ALLOWED_RUNTIME_ORIGINS = brokerUrl + "," + codex.url;
});
afterAll(async () => {
  await Promise.all(
    [server, broker].map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
  db.close();
  await codex.close();
  rmSync(dir, { recursive: true, force: true });
});
async function api(
  path: string,
  body?: unknown,
  method?: string,
  owner = "alice",
) {
  const r = await fetch(origin + path, {
    method: method || (body ? "POST" : "GET"),
    headers: { "content-type": "application/json", "x-test-owner": owner },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json() };
}
it("tests a remote machine, encrypts its token and keeps its provider login scoped to the owner", async () => {
  const host = await api("/runtime-hosts", {
    name: "Workstation",
    url: brokerUrl,
    token,
  });
  expect(host.status).toBe(201);
  expect(JSON.stringify((await api("/runtime-hosts")).data)).not.toContain(
    token,
  );
  expect(
    (
      db
        .prepare("SELECT secret FROM runtime_hosts WHERE id=?")
        .get(host.data.id) as any
    ).secret,
  ).not.toContain(token);
  expect(() => runtimeEndpoint("bob", host.data.id)).toThrow("Item not found");
  const connection = await api("/subscriptions", {
    provider: "claude",
    label: "Remote Claude",
    runtimeHostId: host.data.id,
  });
  expect(connection.status).toBe(201);
  const login = await api(
    "/subscriptions/" + connection.data.id + "/login",
    {},
  );
  expect(login.data.login.url).toContain("claude.ai");
  expect(requests.at(-1).provider).toBe("claude");
  const status = await api(
    "/subscriptions/" + connection.data.id + "/status",
    {},
  );
  expect(status.data.authenticated).toBe(true);
  expect(
    (
      await api(
        "/subscriptions/" + connection.data.id + "/status",
        {},
        "POST",
        "bob",
      )
    ).status,
  ).toBe(404);
  expect(
    (await api("/runtime-hosts/" + host.data.id, {}, "DELETE")).status,
  ).toBe(409);
});
it("rejects private runtime addresses without explicit administrator configuration", async () => {
  const result = await api("/runtime-hosts", {
    name: "Private",
    url: "http://127.0.0.1:1",
    token,
  });
  expect(result.status).toBe(400);
});
it("pairs native hosts separately from isolated brokers and keeps their tools out of the workspace MCP installer", async () => {
  const spec = {
    name: "Native laptop",
    url: brokerUrl,
    token,
    kind: "native-host",
  };
  expect((await api("/runtime-hosts", spec)).status).toBe(422);
  brokerKind = "native-host";
  let host;
  try {
    expect(
      (await api("/runtime-hosts", { ...spec, kind: "broker" })).status,
    ).toBe(422);
    host = await api("/runtime-hosts", spec);
    expect(host.status).toBe(201);
  } finally {
    brokerKind = "broker";
  }
  expect(runtimeEndpoint("alice", host!.data.id, "claude").kind).toBe(
    "native-host",
  );
  expect(runtimeEndpoint("alice", host!.data.id, "codex").kind).toBe(
    "native-host",
  );
  expect(() => runtimeEndpoint("bob", host!.data.id, "claude")).toThrow(
    "Item not found",
  );
  expect(() => runtimeEndpoint("alice", host!.data.id)).toThrow(
    "workspace MCPs",
  );
  expect(
    (await api("/runtime-hosts")).data.find((h: any) => h.id === host!.data.id)
      .kind,
  ).toBe("native-host");
  const connection = await api("/subscriptions", {
    provider: "claude",
    label: "Native Claude",
    runtimeHostId: host!.data.id,
  });
  expect(connection.status).toBe(201);
  expect(
    JSON.parse(
      (
        db
          .prepare("SELECT metadata FROM connections WHERE id=?")
          .get(connection.data.id) as any
      ).metadata,
    ).runtimeKind,
  ).toBe("native-host");
  await api(`/connections/${connection.data.id}`, {}, "DELETE");
  await api(`/runtime-hosts/${host!.data.id}`, {}, "DELETE");
});
it("clears signing_in after a failed login so retry starts a new flow", async () => {
  const host = id(),
    connection = id();
  db.prepare(
    "INSERT INTO runtime_hosts(id,owner_id,name,url,secret,created_at) VALUES(?,?,?,?,?,?)",
  ).run(host, "alice", "Unavailable", brokerUrl, "not-encrypted", now());
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,metadata,created_at) VALUES(?,?,'anthropic','Retry','','needs_sign_in',?,?)",
  ).run(
    connection,
    "alice",
    JSON.stringify({
      authMode: "subscription",
      runtime: "claude",
      runtimeHostId: host,
    }),
    now(),
  );
  expect(
    (await api("/subscriptions/" + connection + "/login", {})).status,
  ).toBeGreaterThanOrEqual(400);
  expect(
    db.prepare("SELECT status FROM connections WHERE id=?").get(connection),
  ).toEqual({ status: "needs_sign_in" });
});

it("clears a stalled sign-in and returns the runtime's retry message when polling reports its deadline", async () => {
  const host = await api("/runtime-hosts", {
    name: "Login deadline",
    url: brokerUrl,
    token,
  });
  const created = await api("/subscriptions", {
    provider: "claude",
    label: "Stalled Claude",
    runtimeHostId: host.data.id,
  });
  const path = "/subscriptions/" + created.data.id;
  await api(path + "/login", {});
  nextStatus = {
    state: "failed",
    error:
      "The provider did not return a sign-in link within 45 seconds. Try sign-in again.",
  };
  const failed = await api(path + "/status", {});
  expect(failed.data).toMatchObject({
    state: "failed",
    error: expect.stringContaining("Try sign-in again"),
  });
  expect(
    db
      .prepare("SELECT status FROM connections WHERE id=?")
      .get(created.data.id),
  ).toEqual({ status: "needs_sign_in" });
  const retry = await api(path + "/login", {});
  expect(retry.data.state).toBe("waiting");
});

it("pairs Codex app-server, uses the host account, scopes access and never logs that account out", async () => {
  const host = await api("/runtime-hosts", {
    name: "Remote Codex",
    url: codex.url,
    token: codex.token,
    kind: "codex-app-server",
  });
  expect(host.status).toBe(201);
  expect(
    (await api("/runtime-hosts")).data.find((h: any) => h.id === host.data.id),
  ).toMatchObject({ kind: "codex-app-server" });
  expect(JSON.stringify((await api("/runtime-hosts")).data)).not.toContain(
    codex.token,
  );
  expect(() => runtimeEndpoint("bob", host.data.id, "codex")).toThrow(
    "Item not found",
  );
  expect(
    (
      await api("/subscriptions", {
        provider: "claude",
        label: "Invalid",
        runtimeHostId: host.data.id,
      })
    ).status,
  ).toBe(400);
  await expect(
    installConfig(
      "alice",
      { mcpServers: { test: { command: "npx", args: [] } } },
      undefined,
      "",
      host.data.id,
    ),
  ).rejects.toThrow("only runs Codex");
  const created = await api("/subscriptions", {
    provider: "codex",
    label: "Existing account",
    runtimeHostId: host.data.id,
  });
  expect(created.status).toBe(201);
  const login = await api(`/subscriptions/${created.data.id}/login`, {});
  expect(login.status).toBe(200);
  expect(login.data).toMatchObject({
    authenticated: true,
    authMode: "subscription",
  });
  const connection = db
    .prepare("SELECT * FROM connections WHERE id=?")
    .get(created.data.id) as any;
  expect(connection.status).toBe("connected");
  const input = {
    model: "fixture",
    instructions: "Be clear",
    messages: [{ role: "user" as const, content: "Do the work" }],
    signal: new AbortController().signal,
    tools: [
      {
        name: "lookup",
        description: "Fixture",
        inputSchema: { type: "object" },
      },
    ],
  };
  const chunks = [];
  for await (const chunk of subscriptionStream(connection, input))
    chunks.push(chunk);
  expect(chunks).toEqual([
    { text: "Remote Codex fixture response." },
    { externalId: expect.stringMatching(/^fixture-thread-/) },
  ]);
  const thread = codex.calls.findLast((c: any) => c.method === "thread/start");
  expect(thread.params).toMatchObject({
    ephemeral: true,
    modelProvider: "openai",
    sandbox: "danger-full-access",
    config: { forced_login_method: "chatgpt" },
  });
  expect(Object.keys(thread.params.config)).toEqual(["forced_login_method"]);
  expect(
    codex.calls.some(
      (c: any) => c.id === 1000 && c.result?.decision === "accept",
    ),
  ).toBe(true);
  expect(
    codex.calls.some(
      (c: any) => c.id === 1001 && c.result?.decision === "accept",
    ),
  ).toBe(true);
  expect(
    codex.calls.some(
      (c: any) => c.id === 1002 && c.result?.permissions.network.enabled,
    ),
  ).toBe(true);
  expect(codex.calls.some((c: any) => c.id === 1003 && c.error)).toBe(true);
  expect(
    codex.calls.findLast((c: any) => c.method === "turn/start").params.input[0]
      .text,
  ).toContain("all native tools");
  const tools = [];
  for await (const chunk of subscriptionStream(connection, {
    ...input,
    model: "tool",
  }))
    tools.push(chunk);
  expect(tools[0]).toMatchObject({
    toolCall: { name: "lookup", arguments: {} },
  });
  for (const model of ["wrong-provider", "ungranted", "quota", "disconnect"]) {
    await expect(
      (async () => {
        for await (const _chunk of subscriptionStream(connection, {
          ...input,
          model,
        })) {
          /* drain */
        }
      })(),
    ).rejects.toThrow();
  }
  const controller = new AbortController();
  const cancelled = (async () => {
    for await (const _chunk of subscriptionStream(connection, {
      ...input,
      model: "wait",
      signal: controller.signal,
    })) {
      /* drain */
    }
  })();
  // Attach the rejection handler before aborting.
  const stopped = expect(cancelled).rejects.toThrow();
  await expect
    .poll(() =>
      codex.calls.some(
        (c: any) => c.method === "thread/start" && c.params.model === "wait",
      ),
    )
    .toBe(true);
  await expect
    .poll(
      () => codex.calls.filter((c: any) => c.method === "turn/start").length,
    )
    .toBe(6);
  controller.abort();
  await stopped;
  expect(
    codex.calls.findLast((c: any) => c.method === "turn/interrupt")?.params,
  ).toMatchObject({
    threadId: expect.stringMatching(/^fixture-thread-/),
    turnId: expect.stringMatching(/^fixture-turn-/),
  });
  expect(
    (await api(`/connections/${created.data.id}`, {}, "DELETE")).status,
  ).toBe(200);
  expect(
    codex.calls.some((c: any) =>
      ["account/login/start", "account/logout"].includes(c.method),
    ),
  ).toBe(false);
  expect(
    (await api(`/runtime-hosts/${host.data.id}`, {}, "DELETE")).status,
  ).toBe(200);
});

it("discovers only the selected owner’s skills and dispatches native review and skill input", async () => {
  const host = await api("/runtime-hosts", {
    name: "Harness machine",
    url: codex.url,
    token: codex.token,
    kind: "codex-app-server",
  });
  const created = await api("/subscriptions", {
    provider: "codex",
    label: "Harness account",
    runtimeHostId: host.data.id,
  });
  await api(`/subscriptions/${created.data.id}/login`, {});
  const agent = await api("/agents", {
    name: "harness-discovery",
    connectionId: created.data.id,
    model: "fixture",
  });
  const before = codex.calls.length;
  const catalog = await api(`/agents/${agent.data.id}/harness`);
  expect(catalog.data).toMatchObject({
    available: true,
    commands: expect.arrayContaining([
      expect.objectContaining({ token: "$fixture-skill" }),
      expect.objectContaining({ token: "/review" }),
    ]),
  });
  expect(
    catalog.data.commands.some((c: any) => c.token === "$disabled-skill"),
  ).toBe(false);
  expect(
    codex.calls.slice(before).some((c: any) => c.method === "turn/start"),
  ).toBe(false);
  expect(
    (await api(`/agents/${agent.data.id}/harness`, undefined, undefined, "bob"))
      .status,
  ).toBe(404);
  const connection = db
    .prepare("SELECT * FROM connections WHERE id=?")
    .get(created.data.id) as any;
  const run = async (content: string) => {
    const chunks = [];
    for await (const c of subscriptionStream(connection, {
      model: "fixture",
      instructions: "Be clear",
      messages: [{ role: "user", content }],
      signal: new AbortController().signal,
    }))
      chunks.push(c);
    return chunks;
  };
  await run("$fixture-skill check this project");
  expect(
    codex.calls.findLast((c: any) => c.method === "turn/start").params.input,
  ).toContainEqual({
    type: "skill",
    name: "fixture-skill",
    path: "/fixture/SKILL.md",
  });
  expect((await run("/review"))[0]).toEqual({
    text: "Native review completed.",
  });
  expect(
    codex.calls.findLast((c: any) => c.method === "review/start").params.target,
  ).toEqual({ type: "uncommittedChanges" });
  await run("/review check error handling");
  expect(
    codex.calls.findLast((c: any) => c.method === "review/start").params.target,
  ).toEqual({ type: "custom", instructions: "check error handling" });
  await run("Inspect $HOME and $PATH; $disabled-skill is ordinary text");
  const textOnly = codex.calls.findLast((c: any) => c.method === "turn/start")
    .params.input;
  expect(textOnly).toHaveLength(1);
  expect(textOnly[0].text).toContain(
    "Inspect $HOME and $PATH; $disabled-skill is ordinary text",
  );
  await api(`/connections/${created.data.id}`, {}, "DELETE");
  await api(`/runtime-hosts/${host.data.id}`, {}, "DELETE");
});

it("rejects inaccessible, unauthenticated and API-key app-servers before saving a host", async () => {
  const request = {
    name: "Bad Codex",
    url: codex.url,
    token: codex.token,
    kind: "codex-app-server",
  };
  expect(
    (
      await api("/runtime-hosts", {
        ...request,
        token: "wrong-token-with-at-least-32-characters",
      })
    ).status,
  ).toBe(422);
  for (const mode of ["api-key", "signed-out"]) {
    codex.setMode(mode);
    const response = await api("/runtime-hosts", request);
    expect(response.status).toBe(422);
    expect(response.data.error).toContain("codex login");
  }
  codex.setMode("answer");
  expect(
    (await api("/runtime-hosts", { ...request, url: "ws://127.0.0.1:1" }))
      .status,
  ).toBe(400);
  expect(
    (
      await api("/runtime-hosts", {
        ...request,
        url: "wss://user:password@example.com",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await api("/runtime-hosts", {
        ...request,
        url: "wss://example.com?token=secret",
      })
    ).status,
  ).toBe(400);
  expect(
    (await api("/runtime-hosts", { ...request, kind: "broker" })).status,
  ).toBe(400);
});
