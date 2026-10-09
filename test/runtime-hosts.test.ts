import { afterAll, beforeAll, expect, it, vi } from "vitest";
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
const { codexFixture, fixtureToken } = await import(
  resolve("test/helpers/codex-server.mjs")
);
const codex = await codexFixture();
const { codexStream } = await import("../src/server/codex-app-server");
const { core } = await import("../src/server/core-routes");
const { installConfig } = await import("../src/server/mcp/install");
const { Problem } = await import("../src/server/domain");
it("keeps remote Codex work alive beyond the old deadline until the caller cancels", async () => {
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  const clock = vi
    .spyOn(AbortSignal, "timeout")
    .mockImplementation((ms) => originalTimeout(ms >= 1800000 ? 25 : ms));
  const controller = new AbortController();
  const count = codex.calls.filter(
    (c: any) => c.method === "turn/start",
  ).length;
  let settled = false;
  const running = (async () => {
    for await (const _chunk of codexStream(
      { url: codex.url, token: fixtureToken },
      {
        model: "wait",
        instructions: "Wait for CI",
        messages: [{ role: "user", content: "Long coding task" }],
        signal: controller.signal,
      },
    )) {
      /* drain */
    }
  })().then(
    () => {
      settled = true;
      return null;
    },
    (error) => {
      settled = true;
      return error;
    },
  );
  try {
    await expect
      .poll(
        () => codex.calls.filter((c: any) => c.method === "turn/start").length,
      )
      .toBe(count + 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(settled).toBe(false);
  } finally {
    controller.abort();
    expect(await running).toBeInstanceOf(Error);
    clock.mockRestore();
    // The other protocol scenarios use their own call sequence assertions.
    codex.calls.length = 0;
  }
});
it("interrupts an unresponsive remote turn and releases its socket", async () => {
  const schedule = globalThis.setTimeout;
  const clock = vi
    .spyOn(globalThis, "setTimeout")
    .mockImplementation(((callback: any, ms: number, ...args: any[]) =>
      schedule(
        callback,
        ms === 60 * 60_000 ? 100 : ms,
        ...args,
      )) as typeof setTimeout);
  try {
    await expect(
      (async () => {
        for await (const _chunk of codexStream(
          { url: codex.url, token: fixtureToken },
          {
            model: "wait",
            instructions: "Wait",
            messages: [{ role: "user", content: "Wait" }],
            signal: new AbortController().signal,
          },
        )) {
          /* drain */
        }
      })(),
    ).rejects.toMatchObject({
      status: 408,
      message: expect.stringContaining("no progress for 60 minutes"),
    });
    expect(codex.calls.some((c: any) => c.method === "turn/interrupt")).toBe(
      true,
    );
    expect(
      codex.calls.some((c: any) => c.method === "thread/unsubscribe"),
    ).toBe(true);
  } finally {
    clock.mockRestore();
    codex.calls.length = 0;
  }
});
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
  expect(connection.status).toBe(410);
  expect(connection.data.error).toContain("HAPI");

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
  expect(connection.status).toBe(410);
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

it("retired subscription endpoints never contact the registered runtime", async () => {
  const before = requests.length;
  for (const path of ["/subscriptions", "/subscriptions/old/login", "/subscriptions/old/status"]) {
    const response = await api(path, {provider:"codex",label:"Old"});
    expect(response.status).toBe(410);
    expect(response.data.error).toContain("HAPI");
  }
  expect(requests).toHaveLength(before);
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
