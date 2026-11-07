import { expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { cardsFixture } from "./helpers/cards-fixture";
import { integrationTokenRequest } from "../src/shared/card-access";
import {
  workspaceApi,
  workspaceRoutes,
  type RouteContract,
  type FleetRouteContract,
} from "../src/shared/workspace-api";
import { fleetAdminApi } from "../src/shared/fleet-admin-api";
import { fleetCredentialApi } from "../src/shared/fleet-credential-api";
import { TokenScope } from "../src/shared/token-scopes";

const fleet: FleetRouteContract = {
  ...Object.values(fleetAdminApi)[0],
  // @ts-expect-error A fleet registry accepts only its dedicated string access.
  access: { admits: ["read"] },
};
const peer: FleetRouteContract = {
  ...fleetCredentialApi.credentialChallenge,
  // @ts-expect-error A peer registry cannot combine its access with token admission.
  access: { admits: ["read"], peer: "peer:credentials" },
};
// @ts-expect-error A bearer-admitted mutation must name its body identity.
const writeWithoutIdentity: RouteContract = {
  ...workspaceApi.approvals,
  method: "POST",
  access: { admits: ["write"] },
};
// @ts-expect-error Mixing read and decision admissions still requires identity.
const decisionWithoutIdentity: RouteContract = {
  ...workspaceApi.approvals,
  method: "PATCH",
  access: { admits: ["read", "approvals:decide"] },
};
void [fleet, peer, writeWithoutIdentity, decisionWithoutIdentity];

it("companion admits the declared read catalog with GET/HEAD, safe projections and owner isolation", async () => {
  const f = await cardsFixture();
  const local = await f.integrationRecords();
  const foreign = await f.integrationRecords(randomUUID());
  const created = await f.request("/api/card-tokens", {
    headers: f.browser,
    body: integrationTokenRequest("Reader", ["read"]),
  });
  expect(created.status).toBe(201);
  const { token, secret } = await created.json();
  expect(secret).toMatch(/^loop_token_[\w-]{43}$/);
  expect(token).toMatchObject({ scopes: ["read"] });
  const headers = { ...f.browser, authorization: "Bearer " + secret };
  // Unknown storage columns must not become public fields just because the
  // request was admitted through the bearer path. Existing encrypted secret
  // and run payload fields are also exercised by these records.
  const sentinel = "private-integration-column";
  for (const table of [
    "agents",
    "connections",
    "runs",
    "conversations",
    "messages",
    "artifacts",
    "approvals",
    "native_decisions",
    "objects",
    "artifact_objects",
    "run_traces",
  ]) {
    f.db.exec(`ALTER TABLE ${table} ADD COLUMN fixture_secret TEXT`);
    f.db.prepare(`UPDATE ${table} SET fixture_secret=?`).run(sentinel);
  }
  const cards = await f.request("/api/v1/cards", { headers });
  expect(cards.status).toBe(200);
  const revision = (await cards.json()).revision;
  // A committed change after the cursor makes changes exercise a real card.
  f.db
    .prepare("UPDATE artifacts SET content='Public result updated' WHERE id=?")
    .run(local.artifact);
  const paths: Partial<Record<keyof typeof workspaceApi, string>> = {
    bootstrap: "/bootstrap",
    events: "/events?after=0",
    agentDetail: `/agents/${local.agent}`,
    agentMessages: `/agents/${local.agent}/messages`,
    agentTraces: `/agents/${local.agent}/traces`,
    agentTracesExport: `/agents/${local.agent}/traces/export?run=${local.run}`,
    feed: "/feed",
    feedAway: "/feed/away?since=0",
    conversation: `/conversations/${local.conversation}`,
    messageSearch: "/messages?q=Integration",
    messageDetail: `/messages/${local.message}`,
    runs: "/runs",
    approvals: "/approvals",
    nativeDecisions: `/native/decisions?conversation=${local.conversation}`,
    results: "/results",
    resultUpdates: "/results/updates?after=0&through=0",
    artifactList: "/artifacts",
    artifactDetail: `/artifacts/${local.artifact}`,
    artifactFile: `/artifacts/${local.published}/file`,
    artifactDownload: `/artifacts/${local.published}/download`,
    objectFile: `/objects/${local.file.objectId}`,
    cardList: "/v1/cards",
    cardDetail: `/v1/cards/a%3A${local.artifact}`,
    cardChanges: `/v1/cards/changes?after=${encodeURIComponent(revision)}`,
  };
  const admitted = Object.entries(workspaceRoutes)
    .filter(
      ([, route]) =>
        typeof route.access === "object" &&
        !("security" in route && route.security === "integration-token") &&
        route.access.admits.some((scope) => scope === "read"),
    )
    .map(([name]) => name)
    .sort();
  expect(Object.keys(paths).sort()).toEqual(admitted);
  const visible: Partial<Record<keyof typeof workspaceApi, string>> = {
    bootstrap: local.agent,
    events: local.message,
    agentDetail: local.agent,
    agentMessages: local.reply,
    agentTraces: "Fixture trace",
    agentTracesExport: "Fixture trace",
    feed: local.conversation,
    feedAway: local.run,
    conversation: local.message,
    messageSearch: local.message,
    messageDetail: local.message,
    runs: local.run,
    approvals: local.approval,
    nativeDecisions: local.decision,
    results: local.artifact,
    resultUpdates: local.artifact,
    artifactList: local.artifact,
    artifactDetail: local.artifact,
    artifactFile: "Published file bytes",
    objectFile: "Public file bytes",
    cardList: local.artifact,
    cardDetail: local.artifact,
    cardChanges: local.artifact,
  };
  const eventsBeforeReads = f.db.prepare("SELECT count(*) n FROM events").get();
  for (const [name, path] of Object.entries(paths)) {
    for (const method of ["GET", "HEAD"]) {
      const response = await f.request("/api" + path, { method, headers });
      const body = await response.text();
      const status = name === "artifactDownload" ? 303 : 200;
      expect(response.status, `${method} ${path}: ${body}`).toBe(status);
      expect(body).not.toContain(sentinel);
      expect(body).not.toContain("integration-fixture-credential");
      expect(body).not.toContain(foreign.agent);
      expect(body).not.toContain(foreign.run);
      expect(body).not.toContain(foreign.artifact);
      expect(response.headers.get("x-loop-change-cursor")).toBeNull();
      if (
        method === "GET" &&
        status === 200 &&
        response.headers.get("content-type")?.includes("application/json")
      ) {
        expect(JSON.parse(body), path).not.toHaveProperty("projection");
        expect(JSON.parse(body), path).not.toHaveProperty("projectionRows");
      }
      if (method === "GET" && status === 200)
        expect(body, path).toContain(
          visible[name as keyof typeof workspaceApi],
        );
      if (method === "HEAD") expect(body).toBe("");
    }
  }
  expect(f.db.prepare("SELECT count(*) n FROM events").get()).toEqual(
    eventsBeforeReads,
  );
  for (const path of [
    `/agents/${foreign.agent}`,
    `/agents/${foreign.agent}/messages`,
    `/agents/${foreign.agent}/traces`,
    `/agents/${foreign.agent}/traces/export?run=${foreign.run}`,
    `/conversations/${foreign.conversation}`,
    `/messages/${foreign.message}`,
    `/artifacts/${foreign.artifact}`,
    `/artifacts/${foreign.published}/file`,
    `/artifacts/${foreign.published}/download`,
    `/objects/${foreign.file.objectId}`,
    `/v1/cards/a%3A${foreign.artifact}`,
  ]) {
    for (const method of ["GET", "HEAD"])
      expect(
        (await f.request("/api" + path, { method, headers })).status,
        path,
      ).toBe(404);
  }
  expect(
    (
      await f.request(
        `/api/native/decisions?conversation=${foreign.conversation}`,
        { headers },
      )
    ).status,
  ).toBe(404);
  expect(
    f.db
      .prepare(
        "SELECT card_id FROM card_token_reads WHERE token_id=? ORDER BY card_id",
      )
      .all(token.id),
  ).toEqual(
    expect.arrayContaining([
      { card_id: "a:" + local.artifact },
      { card_id: "a:" + local.published },
    ]),
  );
  for (const path of [
    "/v1/cards?view=done",
    "/card-tokens",
    "/connections",
    "/events/ws",
    "/workspace/devices",
    "/agent-sources",
    "/mcp-sharing",
    "/native/history?discover=1",
    "/fleet/admin/state",
    "/fleet/peer/v1/directory/history",
    "/agent-sources/foreign/api/bootstrap",
    "/missing",
  ]) {
    expect((await f.request("/api" + path, { headers })).status, path).toBe(
      403,
    );
  }
  for (const path of [
    "/runs",
    `/runs/${local.run}/cancel`,
    `/approvals/${local.approval}`,
    `/native/decisions/${local.decision}`,
    "/card-tokens",
    "/fleet/admin/create",
    "/fleet/peer/v1/enrollment/probe",
    "/fleet/peer/v1/credentials/challenge",
    "/fleet/peer/v1/credentials/issue",
    "/ui/viewport-diagnostics",
  ]) {
    expect(
      (await f.request("/api" + path, { method: "POST", headers, body: {} }))
        .status,
      path,
    ).toBe(403);
  }
  // Default Express registries retain their case and trailing-slash matching;
  // the Cards compatibility boundary remains strict (existing Card tests).
  expect((await f.request("/API/BOOTSTRAP/", { headers })).status).toBe(200);
  expect(
    (
      await f.request("/api/bootstrap", {
        headers: { ...headers, "x-http-method-override": "POST" },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await f.request("/api/bootstrap", {
        headers: { ...headers, origin: "https://foreign.example" },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await f.request("/api/bootstrap", {
        headers: {
          ...headers,
          authorization: "Bearer loop_token_" + "x".repeat(43),
        },
      })
    ).status,
  ).toBe(401);
  const before = f.db.prepare("SELECT count(*) n FROM runs").get();
  expect(
    (
      await f.request("/api/runs", {
        method: "POST",
        body: {
          agentId: local.agent,
          input: "Must not dispatch",
          idempotencyKey: randomUUID(),
        },
        headers,
      })
    ).status,
  ).toBe(403);
  expect(f.db.prepare("SELECT count(*) n FROM runs").get()).toEqual(before);
  expect(
    (
      await f.request("/api/card-tokens/" + token.id, {
        method: "DELETE",
        headers: f.browser,
      })
    ).status,
  ).toBe(200);
  expect((await f.request("/api/bootstrap", { headers })).status).toBe(401);
}, 60000);

it("companion keeps management closed and enforces each integration scope", async () => {
  const f = await cardsFixture();
  for (const scope of TokenScope.options) {
    const input = integrationTokenRequest(scope, [scope]);
    const wrongPrefix = input.secret.replace("loop_token_", "loop_card_");
    expect(
      (
        await f.request("/api/card-tokens", {
          headers: f.browser,
          body: { ...input, secret: wrongPrefix },
        })
      ).status,
    ).toBe(400);
    const created = await f.request("/api/card-tokens", {
      headers: f.browser,
      body: input,
    });
    expect(created.status).toBe(201);
    const { secret } = await created.json();
    const headers = { ...f.browser, authorization: "Bearer " + secret };
    for (const method of ["GET", "HEAD"]) {
      expect(
        (await f.request("/api/bootstrap", { method, headers })).status,
      ).toBe(scope === "read" ? 200 : 403);
      expect((await f.request("/api/events", { method, headers })).status).toBe(
        scope === "read" ? 200 : 403,
      );
      expect(
        (await f.request("/api/v1/cards", { method, headers })).status,
      ).toBe(scope === "read" ? 200 : 403);
      for (const path of [
        "/api/card-tokens",
        "/api/fleet/admin/state",
        "/api/fleet/peer/v1/directory/history",
        "/api/v1/cards?view=done",
      ])
        expect((await f.request(path, { method, headers })).status).toBe(403);
    }
    for (const path of [
      "/api/fleet/admin/create",
      "/api/fleet/peer/v1/enrollment/probe",
      "/api/fleet/peer/v1/credentials/challenge",
      "/api/fleet/peer/v1/credentials/issue",
    ])
      expect((await f.request(path, { body: {}, headers })).status).toBe(403);
  }
}, 60000);

it("companion qualifies Results/artifact disclosures per token before returning removals", async () => {
  const f = await cardsFixture();
  const records = await f.integrationRecords();
  const create = async (name: string) => {
    const response = await f.request("/api/card-tokens", {
      headers: f.browser,
      body: integrationTokenRequest(name, ["read"]),
    });
    expect(response.status).toBe(201);
    const receipt = await response.json();
    return {
      id: receipt.token.id as string,
      headers: { authorization: "Bearer " + receipt.secret },
    };
  };
  const detail = await create("Detail"),
    listing = await create("Listing"),
    unseen = await create("Unseen"),
    headOnly = await create("HEAD only");
  const before = await (
    await f.request("/api/v1/cards", { headers: f.browser })
  ).json();
  f.db
    .prepare(
      "UPDATE artifacts SET content='Updated for HEAD changes' WHERE id=?",
    )
    .run(records.artifact);
  for (const path of [
    "/api/results",
    "/api/results/updates?after=0&through=0",
    "/api/artifacts",
    "/api/v1/cards",
    `/api/v1/cards/changes?after=${encodeURIComponent(before.revision)}`,
    `/api/artifacts/${records.artifact}`,
    `/api/v1/cards/a%3A${records.artifact}`,
    `/api/artifacts/${records.published}/file`,
  ]) {
    const response = await f.request(path, {
      method: "HEAD",
      headers: headOnly.headers,
    });
    expect(response.status, path).toBe(200);
    expect(await response.text()).toBe("");
  }
  expect(
    f.db
      .prepare("SELECT card_id FROM card_token_reads WHERE token_id=?")
      .all(headOnly.id),
  ).toEqual([]);
  expect(
    (
      await f.request(`/api/artifacts/${records.artifact}`, {
        headers: detail.headers,
      })
    ).status,
  ).toBe(200);
  const page = await f.request("/api/results", { headers: listing.headers });
  expect(
    (await page.json()).items.map((item: { id: string }) => item.id),
  ).toContain(records.artifact);
  f.db
    .prepare("UPDATE artifacts SET archived=1 WHERE id=?")
    .run(records.artifact);
  for (const token of [detail, listing, unseen, headOnly]) {
    const response = await f.request("/api/results/updates?after=0&through=0", {
      headers: token.headers,
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    if (token === unseen || token === headOnly)
      expect(body.removed).not.toContain(records.artifact);
    else expect(body.removed).toContain(records.artifact);
    expect(
      f.db
        .prepare(
          "SELECT 1 FROM card_token_reads WHERE token_id=? AND owner_id=? AND card_id=?",
        )
        .get(token.id, f.owner, "a:" + records.artifact),
    ).toEqual(token === unseen || token === headOnly ? undefined : { "1": 1 });
  }
}, 60000);

it("companion keeps Results reads and disclosures coherent while a worker tries to commit", async () => {
  const f = await cardsFixture();
  const records = await f.integrationRecords();
  for (const path of [
    "/api/results",
    "/api/results/updates?after=0&through=0",
  ]) {
    const created = await f.request("/api/card-tokens", {
      headers: f.browser,
      body: integrationTokenRequest(path, ["read"]),
    });
    expect(created.status).toBe(201);
    const { token, secret } = await created.json();
    const finish = await f.interleaveResultWrite(records.artifact);
    const response = await f.request(path, {
      headers: { authorization: "Bearer " + secret },
    });
    expect(await finish()).toEqual({ attempted: true, committed: true });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(
      body.items.some((item: { id: string }) => item.id === records.artifact),
    ).toBe(true);
    expect(
      f.db
        .prepare(
          "SELECT card_id FROM card_token_reads WHERE token_id=? AND card_id=?",
        )
        .get(token.id, "a:" + records.artifact),
    ).toEqual({ card_id: "a:" + records.artifact });
  }
}, 60000);

it("rejects invalid credential prefixes and grants at the companion HTTP boundary", async () => {
  const f = await cardsFixture();
  try {
    for (const prefix of ["loop_card_", "invalid_card_", "invalid_token_"]) {
      const request = integrationTokenRequest("Rejected credential", ["read"]);
      request.secret = request.secret.replace("loop_token_", prefix);
      const created = await f.request("/api/card-tokens", {
        headers: f.browser,
        body: request,
      });
      expect(created.status, prefix).toBe(400);
      expect(
        f.db
          .prepare("SELECT id FROM card_tokens WHERE id=?")
          .get(request.request_id),
      ).toBeUndefined();
      // Matching owner, digest and current scope ensure rejection is by wire
      // format, not merely an unknown credential or insufficient authority.
      f.db
        .prepare(
          "INSERT INTO card_tokens(id,owner_id,name,digest,scope,created_at) VALUES(?,?,?,?,?,1)",
        )
        .run(
          request.request_id,
          f.owner,
          request.name,
          createHash("sha256").update(request.secret).digest("hex"),
          '["read"]',
        );
      for (const method of ["GET", "HEAD"])
        for (const session of [{}, f.browser]) {
          const denied = await f.request("/api/v1/cards", {
            method,
            headers: { ...session, authorization: "Bearer " + request.secret },
          });
          expect(denied.status, prefix + " " + method).toBe(401);
        }
    }
    for (const scope of ["results:read", "cards:read"]) {
      const { scopes, ...request } = integrationTokenRequest("Rejected grant", [
        "read",
      ]);
      for (const body of [
        { ...request, scope },
        { ...request, scopes: [scope] },
      ])
        expect(
          (await f.request("/api/card-tokens", { headers: f.browser, body }))
            .status,
        ).toBe(400);
    }
    const request = integrationTokenRequest("Current integration", ["read"]);
    const created = await f.request("/api/card-tokens", {
      headers: f.browser,
      body: request,
    });
    expect(created.status).toBe(201);
    const { token, secret } = await created.json();
    expect(secret).toBe(request.secret);
    const headers = { authorization: "Bearer " + secret };
    expect((await f.request("/api/v1/cards", { headers })).status).toBe(200);
    await f.request("/api/card-tokens/" + token.id, {
      method: "DELETE",
      headers: f.browser,
    });
    expect((await f.request("/api/v1/cards", { headers })).status).toBe(401);
  } finally {
    await f.close();
  }
}, 15_000);

it("manages all current token scopes and revoked metadata on a fresh database", async () => {
  const f = await cardsFixture();
  try {
    const list = async () => {
      const response = await f.request("/api/card-tokens", {
        headers: f.browser,
      });
      expect(response.status).toBe(200);
      return response.json();
    };
    expect(await list()).toEqual([]);
    const scopes = TokenScope.options;
    for (const selected of [...scopes.map((scope) => [scope]), [...scopes]]) {
      const request = integrationTokenRequest(selected.join(", "), selected);
      const create = () =>
        f.request("/api/card-tokens", {
          headers: f.browser,
          body: request,
        });
      const response = await create();
      expect(response.status).toBe(201);
      const created = await response.json();
      expect(await (await create()).json()).toEqual(created);
      expect(await list()).toContainEqual(created.token);
      const revoked = await f.request("/api/card-tokens/" + created.token.id, {
        method: "DELETE",
        headers: f.browser,
      });
      expect(revoked.status).toBe(200);
      expect(await list()).toContainEqual({
        ...created.token,
        revoked_at: expect.any(Number),
      });
      expect((await create()).status).toBe(409);
    }
    const metadata = await list();
    expect(metadata).toHaveLength(scopes.length + 1);
    for (const token of metadata) {
      expect(token.scopes.length).toBeGreaterThan(0);
      expect(
        token.scopes.every((scope: string) =>
          scopes.includes(scope as (typeof scopes)[number]),
        ),
      ).toBe(true);
      expect(token).not.toHaveProperty("secret");
      expect(token).not.toHaveProperty("digest");
    }
  } finally {
    await f.close();
  }
}, 15_000);
