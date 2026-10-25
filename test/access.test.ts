import { afterAll, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";

const directories: string[] = [];
const processes: ChildProcess[] = [];
const authSecret = randomBytes(32).toString("hex");
const encryptionKey = randomBytes(32).toString("hex");
function directory() {
  const path = mkdtempSync(join(tmpdir(), "loop-access-"));
  directories.push(path);
  return path;
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill();
  await exited;
}
afterAll(async () => {
  await Promise.all(processes.map(stop));
  for (const path of directories)
    rmSync(path, { recursive: true, force: true });
});
async function launch(
  dir: string,
  options: Record<string, string> = {},
  failure = false,
) {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const origin = "http://127.0.0.1:" + port;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/server/serve.ts"],
    {
      env: {
        ...process.env,
        NODE_ENV: "test",
        LOOP_DATA_DIR: dir,
        PORT: String(port),
        LOOP_URL: origin,
        LOOP_LISTEN_HOST: "127.0.0.1",
        LOOP_AUTH_MODE: "",
        LOOP_SINGLE_USER_EMAIL: "",
        LOOP_GATEWAY_TOKEN: "",
        LOOP_LOOPBACK_PROXY: "0",
        LOOP_BIND_ADDRESS: "127.0.0.1",
        BETTER_AUTH_SECRET: authSecret,
        LOOP_ENCRYPTION_KEY: encryptionKey,
        ...options,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  processes.push(child);
  let errors = "";
  child.stderr?.on("data", (chunk) => (errors += chunk));
  if (failure) {
    await expect.poll(() => child.exitCode, { timeout: 15000 }).toBe(1);
  } else {
    await expect
      .poll(
        async () => {
          if (child.exitCode !== null) throw new Error(errors);
          return fetch(origin + "/api/auth-options")
            .then((r) => r.ok)
            .catch(() => false);
        },
        { timeout: 15000 },
      )
      .toBe(true);
  }
  return {
    child,
    origin,
    errors,
    request(
      path: string,
      body?: unknown,
      headers: Record<string, string> = {},
      method = body ? "POST" : "GET",
    ) {
      // Exercise the actual Host header, including rebinding attempts. Fetch
      // implementations can replace it with the URL's authority.
      return new Promise<Response>((resolve, reject) => {
        const request = httpRequest(
          origin + "/api" + path,
          {
            method,
            headers: { "content-type": "application/json", ...headers },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () => {
              const received = new Headers();
              for (const [key, value] of Object.entries(response.headers))
                for (const item of Array.isArray(value)
                  ? value
                  : value
                    ? [value]
                    : [])
                  received.append(key, item);
              resolve(
                new Response(Buffer.concat(chunks).toString(), {
                  status: response.statusCode,
                  headers: received,
                }),
              );
            });
            response.on("error", reject);
          },
        );
        request.on("error", reject);
        request.end(body ? JSON.stringify(body) : undefined);
      });
    },
  };
}
const sessionPath = "/auth/get-session";

it.each(["single-user", "multi-user"])("preserves app OPTIONS admission and later-router methods in %s mode", async mode => {
  const server = await launch(directory(), { LOOP_AUTH_MODE: mode });
  try {
    for (const path of ["/capabilities", "/auth-options", "/health", "/build"]) {
      const response = await server.request(path, undefined, {}, "OPTIONS");
      expect(response.status, path).toBe(mode === "multi-user" ? 401 : 404);
      expect(response.headers.get("allow"), path).toBeNull();
      expect(await response.json()).toEqual({ error: mode === "multi-user" ? "Sign in to Loop" : "Endpoint not found" });
      const bearer = await server.request(path, undefined, { authorization: "Bearer invalid-fixture", origin: "https://foreign.invalid" }, "OPTIONS");
      expect(bearer.status, path).toBe(403);
      expect(bearer.headers.get("access-control-allow-origin"), path).toBeNull();
    }
    const runs = await server.request("/runs", undefined, {}, "OPTIONS");
    expect(runs.status).toBe(mode === "multi-user" ? 401 : 200);
    expect(runs.headers.get("allow")).toBe(mode === "multi-user" ? null : "POST");
    expect((await server.request("/capabilities")).status).toBe(200);
  } finally {
    await stop(server.child);
  }
}, 30000);

it("keeps running build observations behind the workspace authentication boundary", async () => {
  const personal = await launch(directory());
  const response = await personal.request("/build");
  expect(response.status).toBe(200);
  const data = await response.json();
  expect(data.serving).toMatchObject({ id: "development", clean: false });
  expect(data.processes).toEqual([expect.objectContaining({ role: "api" })]);
  expect(JSON.stringify(data)).not.toMatch(/ancestors|secret|directory|token/i);
  expect(
    (await personal.request("/build", undefined, { host: "rebinding.example" })).status,
  ).toBe(403);
  await stop(personal.child);
  const shared = await launch(directory(), { LOOP_AUTH_MODE: "multi-user" });
  expect((await shared.request("/build")).status).toBe(401);
  await stop(shared.child);
}, 30000);

it("opens a persistent personal workspace without accounts or cookies and rejects cross-site access", async () => {
  const dir = directory();
  let server = await launch(dir);
  const response = await server.request(sessionPath);
  const identity = await response.json();
  expect(response.status).toBe(200);
  expect(response.headers.getSetCookie()).toHaveLength(0);
  expect(identity.mode).toBe("single-user");
  expect((await server.request("/auth/sign-up/email", {})).status).toBe(404);
  const folder = { name: "Personal research", kind: "project" };
  expect((await server.request("/folders", folder)).status).toBe(403);
  expect(
    (
      await server.request("/folders", folder, {
        origin: "https://elsewhere.example",
      })
    ).status,
  ).toBe(403);
  expect(
    (await server.request("/folders", folder, { origin: server.origin }))
      .status,
  ).toBe(201);
  const deniedHeaders: Record<string, string>[] = [
    { origin: "https://elsewhere.example" },
    {
      host: "rebinding.example",
      "x-forwarded-for": "127.0.0.1",
      "x-forwarded-host": "localhost",
    },
    { "sec-fetch-site": "cross-site" },
  ];
  for (const headers of deniedHeaders)
    expect((await server.request(sessionPath, undefined, headers)).status).toBe(
      403,
    );
  const authDb = new Database(join(dir, "auth.db"), { readonly: true });
  expect(authDb.prepare("SELECT count(*) AS n FROM user").get()).toEqual({
    n: 0,
  });
  authDb.close();
  await stop(server.child);
  server = await launch(dir);
  expect((await (await server.request(sessionPath)).json()).user.id).toBe(
    identity.user.id,
  );
  expect(
    (await (await server.request("/bootstrap")).json()).folders.map(
      (f: any) => f.name,
    ),
  ).toEqual([folder.name, "Workspace"]);
}, 30000);

it("reuses an existing account's workspace, preserves multi-user isolation and requires an explicit choice between accounts", async () => {
  const dir = directory();
  let server = await launch(dir, { LOOP_AUTH_MODE: "multi-user" });
  expect(await (await server.request(sessionPath)).json()).toBeNull();
  expect((await server.request("/bootstrap")).status).toBe(401);
  expect((await server.request("/me/prompts?owner=someone-else")).status).toBe(
    401,
  );
  const email = "existing@example.com";
  const password = "fixture-password-for-existing-account";
  const signup = await server.request(
    "/auth/sign-up/email",
    { name: "Existing owner", email, password },
    { origin: server.origin },
  );
  expect(signup.status).toBe(200);
  const owner = (await signup.json()).user;
  let cookie = signup.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const folder = await (
    await server.request(
      "/folders",
      { name: "Existing work", kind: "project" },
      { origin: server.origin, cookie },
    )
  ).json();
  await stop(server.child);
  server = await launch(dir);
  expect((await (await server.request(sessionPath)).json()).user.id).toBe(
    owner.id,
  );
  expect(
    (await (await server.request("/bootstrap")).json()).folders[0].id,
  ).toBe(folder.id);
  await stop(server.child);

  server = await launch(dir, { LOOP_AUTH_MODE: "multi-user" });
  const signedIn = await server.request(
    "/auth/sign-in/email",
    { email, password },
    { origin: server.origin },
  );
  expect(signedIn.status).toBe(200);
  cookie = signedIn.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  expect(
    (await (await server.request("/bootstrap", undefined, { cookie })).json())
      .folders[0].id,
  ).toBe(folder.id);
  const other = await server.request(
    "/auth/sign-up/email",
    { name: "Other owner", email: "other@example.com", password },
    { origin: server.origin },
  );
  const otherCookie = other.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const otherOwner = (await other.json()).user.id as string;
  const historyDb = new Database(join(dir, "loop.db"));
  for (const [id, user] of [
    ["owned-prompt", owner.id],
    ["foreign-prompt", otherOwner],
  ]) {
    historyDb
      .prepare(
        "INSERT INTO conversations(id,owner_id,title,created_at) VALUES(?,?,?,1)",
      )
      .run(id, user, id);
    historyDb
      .prepare(
        "INSERT INTO runs(id,owner_id,conversation_id,input,state,idempotency_key,created_at,updated_at) VALUES(?,?,?,'prompt','completed',?,1,1)",
      )
      .run(id, user, id, id);
    historyDb
      .prepare(
        "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,'user',?,'{\"personal\":true}',1)",
      )
      .run(id, user, id, id, id);
  }
  historyDb.close();
  const ownHistory = await server.request(
    "/me/prompts?owner=" + encodeURIComponent(otherOwner),
    undefined,
    { cookie },
  );
  expect(ownHistory.status).toBe(200);
  expect(
    (await ownHistory.json()).items.map((item: { id: string }) => item.id),
  ).toEqual(["owned-prompt"]);
  const foreignHistory = await server.request(
    "/me/prompts?owner=" + encodeURIComponent(owner.id),
    undefined,
    { cookie: otherCookie },
  );
  expect(foreignHistory.status).toBe(200);
  expect(
    (await foreignHistory.json()).items.map((item: { id: string }) => item.id),
  ).toEqual(["foreign-prompt"]);
  const foreignFolders = (
    await (await server.request("/bootstrap", undefined, { cookie: otherCookie })).json()
  ).folders;
  expect(foreignFolders).toHaveLength(1);
  expect(foreignFolders[0]).toMatchObject({ name: "Workspace", is_workspace: 1, owner_id: otherOwner });
  expect(foreignFolders[0].id).not.toBe(folder.id);
  expect(
    (
      await server.request(
        "/folders/" + folder.id,
        { name: "Must not overwrite someone else's work" },
        { origin: server.origin, cookie: otherCookie },
        "PATCH",
      )
    ).status,
  ).toBe(404);
  await stop(server.child);
  // Simulate an older multi-user installation that has not selected an owner.
  const db = new Database(join(dir, "loop.db"));
  db.prepare("DELETE FROM installation").run();
  db.close();
  const ambiguous = await launch(dir, {}, true);
  expect(ambiguous.errors).toContain("Multiple Loop accounts exist");
  server = await launch(dir, { LOOP_SINGLE_USER_EMAIL: email });
  expect((await (await server.request(sessionPath)).json()).user.id).toBe(
    owner.id,
  );
  expect(
    (await (await server.request("/bootstrap")).json()).folders[0].id,
  ).toBe(folder.id);
  expect(
    (await server.request("/auth/sign-in/email", { email, password })).status,
  ).toBe(404);
}, 40000);

it("requires the authenticated gateway for a public hostname while retaining direct local access", async () => {
  const gateway = randomBytes(32).toString("hex");
  const server = await launch(directory(), {
    LOOP_URL: "https://loop.example",
    LOOP_GATEWAY_TOKEN: gateway,
  });
  const remote = { host: "loop.example", origin: "https://loop.example" };
  expect((await server.request(sessionPath, undefined, remote)).status).toBe(
    403,
  );
  expect(
    (
      await server.request(sessionPath, undefined, {
        ...remote,
        "x-forwarded-for": "127.0.0.1",
        "x-loop-gateway-token": "wrong",
      })
    ).status,
  ).toBe(403);
  const headers = { ...remote, "x-loop-gateway-token": gateway };
  const accepted = await server.request(sessionPath, undefined, headers);
  expect(accepted.status).toBe(200);
  expect(accepted.headers.getSetCookie()).toHaveLength(0);
  const identity = await accepted.json();
  expect((await (await server.request(sessionPath)).json()).user.id).toBe(
    identity.user.id,
  );
  expect(
    (
      await server.request("/bootstrap", undefined, {
        ...headers,
        origin: "https://elsewhere.example",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await server.request(
        "/folders",
        { name: "Gateway work", kind: "project" },
        headers,
      )
    ).status,
  ).toBe(201);
  expect(
    (
      await server.request(
        "/folders",
        { name: "Local work", kind: "project" },
        { origin: server.origin },
      )
    ).status,
  ).toBe(201);
}, 20000);

it("refuses unsafe or ambiguous single-user deployment settings", async () => {
  const unprotected = await launch(
    directory(),
    { LOOP_URL: "https://loop.example" },
    true,
  );
  expect(unprotected.errors).toContain("authenticated gateway");
  const publicPort = await launch(
    directory(),
    { LOOP_LOOPBACK_PROXY: "1", LOOP_BIND_ADDRESS: "0.0.0.0" },
    true,
  );
  expect(publicPort.errors).toContain("loopback-only published port");
}, 30000);

it("allows only state-validated OAuth navigations and retains host and gateway checks", async () => {
  const dir = directory();
  const gatewayToken = "fixture-gateway-token-32-characters-long";
  const server = await launch(dir, {
    LOOP_URL: "https://loop.example",
    LOOP_GATEWAY_TOKEN: gatewayToken,
  });
  const owner = (await (await server.request(sessionPath)).json()).user.id;
  const fixtureDb = new Database(join(dir, "loop.db"));
  try {
    fixtureDb
      .prepare(
        "INSERT INTO mcp_connections(id,owner_id,name,url,secret,status,created_at) VALUES('oauth',?,'Fixture','https://fixture.example/mcp','','needs_auth',?)",
      )
      .run(owner, Date.now());
    for (const [state, who, expires] of [
      ["valid", owner, Date.now() + 60000],
      ["expired", owner, 1],
      ["other", "someone-else", Date.now() + 60000],
    ])
      fixtureDb
        .prepare("INSERT INTO oauth_states VALUES(?,?,?,?)")
        .run(state, who, "oauth", expires);
    const navigation = {
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "navigate",
      origin: "https://fixture.example",
    };
    for (const state of ["missing", "expired", "other"])
      expect(
        (
          await server.request(
            "/mcp/oauth/callback?state=" + state,
            undefined,
            navigation,
          )
        ).status,
      ).toBe(403);
    expect(
      (await server.request("/bootstrap?state=valid", undefined, navigation))
        .status,
    ).toBe(403);
    expect(
      (
        await server.request("/mcp/oauth/callback?state=valid", undefined, {
          ...navigation,
          "sec-fetch-mode": "cors",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await server.request("/mcp/oauth/callback?state=valid", undefined, {
          ...navigation,
          host: "loop.example",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await server.request("/mcp/oauth/callback?state=valid", undefined, {
          ...navigation,
          host: "wrong.example",
          "x-loop-gateway-token": gatewayToken,
        })
      ).status,
    ).toBe(403);
    const callback = await server.request(
      "/mcp/oauth/callback?state=valid",
      undefined,
      {
        ...navigation,
        host: "loop.example",
        "x-loop-gateway-token": gatewayToken,
      },
    );
    // Reaching callback validation (with no code to exchange) proves the gate
    // permitted the return navigation. The callback consumes the nonce once.
    expect(callback.status).toBe(400);
    expect(await callback.json()).toEqual({
      error: "MCP sign-in was not completed",
    });
    expect(
      (
        await server.request(
          "/mcp/oauth/callback?state=valid",
          undefined,
          navigation,
        )
      ).status,
    ).toBe(403);
  } finally {
    fixtureDb.close();
    await stop(server.child);
  }
}, 30000);

it("server capabilities retain managed runtimes and do not expose companion routes", async () => {
  const server = await launch(directory());
  const caps = await fetch(server.origin + "/api/capabilities").then((r) =>
    r.json(),
  );
  expect(caps).toMatchObject({
    profile: "server",
    nativeHarnesses: false,
    pairedDevices: false,
    runtimeHosts: true,
  });
  expect((await server.request("/native/decisions")).status).toBe(404);
  expect((await server.request("/workspace")).status).toBe(404);
  await stop(server.child);
});
it("bare server entrypoint refuses companion mode before opening a listener", async () => {
  const server = await launch(directory(), { LOOP_PROFILE: "companion" }, true);
  expect(server.errors).toContain("device authorization");
});
it("data directories cannot cross authorization profiles", async () => {
  const dir = directory();
  const server = await launch(dir);
  await stop(server.child);
  const database = new Database(join(dir, "loop.db"));
  database.prepare("UPDATE deployment_profile SET profile='companion'").run();
  database.close();
  const rejected = await launch(dir, {}, true);
  expect(rejected.errors).toContain("belongs to the companion profile");
}, 30000);

it("companion database startup rejects data bound to the server profile", async () => {
  const dir = directory();
  const server = await launch(dir);
  await stop(server.child);
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      "await import('./src/server/db.ts')",
    ],
    {
      env: { ...process.env, LOOP_DATA_DIR: dir, LOOP_PROFILE: "companion" },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  processes.push(child);
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  const [code] = await once(child, "exit");
  expect(code).not.toBe(0);
  expect(errors).toContain("belongs to the server profile");
});

it("rejects pre-unification databases before migrating them", async () => {
  const dir = directory();
  const database = new Database(join(dir, "loop.db"));
  database.exec(
    "CREATE TABLE schema_version(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL); INSERT INTO schema_version VALUES(1,0)",
  );
  database.close();
  const rejected = await launch(dir, {}, true);
  expect(rejected.errors).toContain(
    "Pre-unification databases are unsupported",
  );
  const unchanged = new Database(join(dir, "loop.db"));
  expect(unchanged.prepare("SELECT * FROM schema_version").all()).toEqual([
    { version: 1, applied_at: 0 },
  ]);
  expect(
    unchanged
      .prepare("SELECT 1 FROM sqlite_master WHERE name='deployment_profile'")
      .get(),
  ).toBeUndefined();
  unchanged.close();
});
