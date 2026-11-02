import { afterAll, beforeAll, expect, it } from "vitest";
import Database from "better-sqlite3";
import { join } from "node:path";
import { cardsFixture } from "./helpers/cards-fixture";
import { workspaceApi } from "../src/shared/workspace-api";

// Let the fixture report its own bounded 20s startup failure on shared hosts.
let fixture: Awaited<ReturnType<typeof cardsFixture>>;
beforeAll(async () => {
  // Building an OAuth authorization URL is local protocol work, not a provider
  // sign-in. The fixture never follows the URL or requests provider tokens.
  const previous = [
    process.env.GITHUB_CLIENT_ID,
    process.env.GITHUB_CLIENT_SECRET,
  ];
  process.env.GITHUB_CLIENT_ID = "contract-fixture-client";
  process.env.GITHUB_CLIENT_SECRET = "contract-fixture-secret";
  try {
    fixture = await cardsFixture("multi-user", false, {
      nodeEnv: "production",
    });
  } finally {
    for (const [key, value] of [
      ["GITHUB_CLIENT_ID", previous[0]],
      ["GITHUB_CLIENT_SECRET", previous[1]],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}, 30_000);
afterAll(async () => fixture?.close());

it("projects actual account sessions while retaining refresh cookies and query semantics", async () => {
  const { request, browser, owner, dir } = fixture;
  const anonymous = await request("/api/auth/get-session");
  expect(anonymous.status).toBe(200);
  expect(
    workspaceApi.authSession.response.parse(await anonymous.json()),
  ).toBeNull();

  const authDb = new Database(join(dir, "auth.db"));
  try {
    const row = authDb
      .prepare('SELECT * FROM session WHERE "userId"=?')
      .get(owner) as { token: string };
    authDb
      .prepare(
        'UPDATE session SET "updatedAt"=?,"expiresAt"=? WHERE "userId"=?',
      )
      .run(Date.now() - 2 * 86400000, Date.now() + 7 * 86400000, owner);
    const unchanged = await request(
      "/api/auth/get-session?disableRefresh=true",
      { headers: browser },
    );
    expect(unchanged.status).toBe(200);
    expect(unchanged.headers.getSetCookie()).toHaveLength(0);
    const renewed = await request("/api/auth/get-session", {
      headers: browser,
    });
    expect(renewed.status).toBe(200);
    expect(
      renewed.headers
        .getSetCookie()
        .some((cookie) => cookie.includes("session_token=")),
    ).toBe(true);
    const value = await renewed.json();
    expect(workspaceApi.authSession.response.parse(value)).toEqual(value);
    expect(value).toEqual({ user: { id: owner, name: "Card owner" } });
    expect(JSON.stringify(value)).not.toContain(row.token);
    expect(value).not.toHaveProperty("session");
    expect(value.user).not.toHaveProperty("email");
    const invalid = await request("/api/auth/get-session", {
      headers: browser,
      method: "GET",
      body: {},
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: expect.any(String) });
  } finally {
    authDb.close();
  }
});

it("retains the account protocol's signup, signin, OAuth URL, signout and owner separation", async () => {
  const { request, browser, origin, owner } = fixture;
  const options = await request("/api/auth-options");
  const discovery = await options.json();
  expect(workspaceApi.authOptions.response.parse(discovery)).toEqual({
    mode: "multi-user",
    github: true,
  });
  const invalidOptions = await request("/api/auth-options", {
    method: "GET",
    body: {},
  });
  expect(invalidOptions.status).toBe(400);
  expect(await invalidOptions.json()).toEqual({ error: expect.any(String) });

  const email = "second-contract-owner@example.com";
  const password = "fixture-contract-password";
  const signup = await request("/api/auth/sign-up/email", {
    headers: { origin },
    body: { name: "Second owner", email, password },
  });
  expect(signup.status).toBe(200);
  const user = (await signup.json()).user;
  expect(user.id).not.toBe(owner);
  const signedIn = await request("/api/auth/sign-in/email", {
    headers: { origin },
    body: { email, password },
  });
  expect(signedIn.status).toBe(200);
  expect(
    workspaceApi.authSignInEmail.body.safeParse({ email, password }).success,
  ).toBe(true);
  const cookie = signedIn.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const identity = await request("/api/auth/get-session", {
    headers: { cookie },
  });
  expect(await identity.json()).toEqual({
    user: { id: user.id, name: "Second owner" },
  });
  const original = await request("/api/auth/get-session", { headers: browser });
  expect((await original.json()).user.id).toBe(owner);

  const social = await request("/api/auth/sign-in/social", {
    headers: { origin },
    body: { provider: "github", callbackURL: origin },
  });
  expect(social.status).toBe(200);
  const redirect = workspaceApi.authSignInSocial.response.parse(
    await social.json(),
  );
  const destination = new URL(redirect.url);
  expect(destination.origin).toBe("https://github.com");
  expect(destination.searchParams.get("client_id")).toBe(
    "contract-fixture-client",
  );
  for (const path of ["sign-up/email", "sign-in/email", "sign-in/social"]) {
    const invalid = await request("/api/auth/" + path, {
      headers: { origin },
      body: {},
    });
    expect(invalid.status, path).toBe(400);
    // The library owns these errors; a workspace Problem envelope must not replace them.
    expect(await invalid.json()).toMatchObject({
      code: expect.any(String),
      message: expect.any(String),
    });
  }
  const signout = await request("/api/auth/sign-out", {
    headers: { origin, cookie },
    body: {},
  });
  expect(signout.status).toBe(200);
  expect(workspaceApi.authSignOut.response.parse(await signout.json())).toEqual(
    { success: true },
  );
  expect(
    signout.headers.getSetCookie().some((value) => value.includes("Max-Age=0")),
  ).toBe(true);
  expect(
    await (
      await request("/api/auth/get-session", { headers: { cookie } })
    ).json(),
  ).toBeNull();
  const deniedSignout = await request("/api/auth/sign-out", {
    headers: { origin: "https://foreign.example", cookie: browser.cookie },
    body: {},
  });
  expect(deniedSignout.status).toBe(403);
  expect(
    (
      await (
        await request("/api/auth/get-session", { headers: browser })
      ).json()
    ).user.id,
  ).toBe(owner);
});
