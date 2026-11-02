import { afterAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { workspaceApi, type RouteContract } from "../src/shared/workspace-api";

const directory = mkdtempSync(join(tmpdir(), "loop55-app-contracts-"));
process.env.LOOP55_DATA_DIR = directory;
process.env.LOOP55_PROFILE = "server";
process.env.LOOP55_AUTH_MODE = "single-user";
process.env.LOOP55_URL = "http://127.0.0.1";
process.env.LOOP55_BIND_ADDRESS = "127.0.0.1";
process.env.LOOP55_GATEWAY_TOKEN = "";
process.env.LOOP55_ENCRYPTION_KEY = randomBytes(32).toString("hex");
process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("hex");
const { db, id } = await import("../src/server/db");
const { config } = await import("../src/server/config");
const { enqueue, claim, transition } = await import("../src/server/queue");
const { observeProcess } = await import("../src/server/deployments");
const { closeExecution } = await import("../src/server/execution-client");
const { nativeSessions } = await import("../src/server/native-sessions");
const { app } = await import("../src/server/index");
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
config.port = (server.address() as AddressInfo).port;
const origin = (config.url = "http://127.0.0.1:" + config.port);
const owner = (
  db.prepare("SELECT owner_id FROM installation WHERE id=1").get() as {
    owner_id: string;
  }
).owner_id;
const stopObservation = observeProcess("api");

afterAll(async () => {
  stopObservation();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeExecution();
  await nativeSessions.close();
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

function request(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
  headers: Record<string, string> = {},
  raw?: string,
) {
  const payload =
    raw ?? (body === undefined ? undefined : JSON.stringify(body));
  return new Promise<{ status: number; data: any; headers: unknown }>(
    (resolve, reject) => {
      const req = httpRequest(
        origin + "/api" + path,
        {
          method,
          headers: {
            "content-type": "application/json",
            origin,
            ...(payload === undefined
              ? {}
              : { "content-length": Buffer.byteLength(payload) }),
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString();
            resolve({
              status: res.statusCode!,
              data: text ? JSON.parse(text) : null,
              headers: res.headers,
            });
          });
        },
      );
      req.on("error", reject);
      req.end(payload);
    },
  );
}
function valid(
  contract: RouteContract,
  response: { status: number; data: unknown },
  status = 200,
) {
  expect(response.status).toBe(status);
  expect(contract.response.parse(response.data)).toEqual(response.data);
}
async function invalid(
  path: string,
  body: unknown,
  method: string,
  headers = {},
) {
  const response = await request(path, body, method, headers);
  expect(response.status, path).toBe(400);
  expect(response.data).toEqual({ error: expect.any(String) });
}

it("no longer serves workflow routes to an authenticated owner", async () => {
  expect((await request("/teams")).status).toBe(200);
  for (const [path, body] of [
    ["/workflows", undefined],
    ["/workflows/validate", { source: "{}" }],
    ["/workflows", { source: "{}" }],
    ["/workflows/fixture", undefined],
    [
      "/workflows/fixture/run",
      { version: 1, inputs: {}, idempotencyKey: "fixture" },
    ],
    ["/runs/fixture/steps", undefined],
  ] as const)
    expect((await request(path, body)).status, path).toBe(404);
});

it("projects public discovery, local identity, health, build and actual diagnostic/event rows", async () => {
  for (const contract of [
    workspaceApi.capabilities,
    workspaceApi.authOptions,
    workspaceApi.authSession,
    workspaceApi.build,
  ]) {
    valid(contract, await request(contract.path));
    await invalid(contract.path, {}, "GET");
  }
  expect((await request("/capabilities")).data.personalApprovalDetails).toBe(
    true,
  );
  expect((await request("/auth/get-session")).data).toEqual({
    mode: "single-user",
    user: { id: owner, name: "Your workspace" },
  });
  expect((await request("/build")).data.processes).toEqual([
    expect.objectContaining({ role: "api" }),
  ]);
  valid(workspaceApi.health, await request("/health"), 503);
  db.prepare("INSERT INTO worker_health VALUES(?,?)").run(
    "fixture-worker",
    Date.now(),
  );
  valid(workspaceApi.health, await request("/health"));
  await invalid("/health", {}, "GET");

  const key = id();
  const created = await request("/diagnostic", { key });
  valid(workspaceApi.diagnostic, created);
  const replay = await request("/diagnostic", { key });
  expect(replay.data.id).toBe(created.data.id);
  const array = await request("/diagnostic", []);
  valid(workspaceApi.diagnostic, array);
  expect(transition(array.data, "cancelled")).toBe(true);
  await invalid("/diagnostic", null, "POST");
  const foreign = enqueue("another-owner", "Foreign diagnostic", id());
  const events = await request("/events?after=0");
  valid(workspaceApi.events, events);
  expect(events.data).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        run_id: created.data.id,
        type: "queued",
        payload: expect.any(String),
      }),
    ]),
  );
  expect(
    events.data.some((row: { run_id: string }) => row.run_id === foreign.id),
  ).toBe(false);
  const after = events.data.at(-1).id;
  expect((await request("/events?after=" + after)).data).toEqual([]);
  await invalid("/events", {}, "GET");
  expect(transition(created.data, "cancelled")).toBe(true);
  expect(transition(foreign, "cancelled")).toBe(true);
});

it("keeps local-only enrollment, opaque MCP dispatch and durable reverse-call identities", async () => {
  const setup = { "x-loop55-source-setup": "1" };
  const peerId = "laptop:" + id();
  const base = "/mcp/federation";
  const enrolled = await request(base + "/enroll", { peerId }, "POST", setup);
  valid(workspaceApi.federationEnroll, enrolled);
  expect(
    (await request(base + "/enroll", { peerId }, "POST", setup)).data,
  ).toEqual(enrolled.data);
  await invalid(base + "/enroll", { peerId: "bad" }, "POST", setup);
  for (const [path, body, method] of [
    [base + "/enroll", { peerId }, "POST"],
    [base + "/import", {}, "POST"],
    [base + "/import-reverse", {}, "POST"],
    [base + "/revoke", { peerId }, "POST"],
    [base + "/pending?peerId=" + peerId, undefined, "GET"],
    [base + "/claim/missing", {}, "POST"],
    [base + "/complete/missing", {}, "POST"],
  ] as const) {
    const denied = await request(path, body, method);
    expect(denied).toMatchObject({
      status: 403,
      data: { error: "Local execution source setup required" },
    });
    expect(JSON.stringify(denied.data)).not.toContain(enrolled.data.token);
  }
  const token = enrolled.data.token;
  const rpcHeaders = {
    authorization: "Bearer " + token,
    accept: "application/json, text/event-stream",
  };
  // MCP clients exercise real HTTP initialize/list calls through the app's ALL mounts.
  for (const path of [base, "/mcp/reverse"]) {
    const client = new Client({ name: "contract fixture", version: "1" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(origin + "/api" + path), {
          requestInit: { headers: { authorization: rpcHeaders.authorization } },
        }),
      );
      expect((await client.listTools()).tools).toEqual([]);
    } finally {
      await client.close();
    }
    const malformed = await fetch(origin + "/api" + path, {
      method: "POST",
      headers: { ...rpcHeaders, "content-type": "application/json" },
      body: "{}",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({
      jsonrpc: "2.0",
      error: expect.any(Object),
    });
    const browser = await request(path, {}, "POST", rpcHeaders);
    expect(browser.status).toBe(403);
  }
  valid(
    workspaceApi.federationImport,
    await request(
      base + "/import",
      {
        peerId,
        label: "Fixture source",
        endpoint: origin + "/api/mcp/federation",
        token,
      },
      "POST",
      setup,
    ),
  );
  await invalid(base + "/import", { peerId, label: 2 }, "POST", setup);

  const tool = {
    name: "shared_" + "a".repeat(24),
    description: "Fixture tool",
    inputSchema: { type: "object" as const, properties: {} },
  };
  valid(
    workspaceApi.federationImportReverse,
    await request(
      base + "/import-reverse",
      {
        peerId,
        label: "Fixture reverse",
        tools: [tool],
      },
      "POST",
      setup,
    ),
  );
  await invalid(
    base + "/import-reverse",
    { peerId, label: "Fixture", tools: null },
    "POST",
    setup,
  );

  const run = enqueue(owner, "Contract reverse-call fixture", id());
  expect(
    claim("fixture-worker", (candidate) => candidate.id === run.id)?.id,
  ).toBe(run.id);
  const client = new Client({ name: "reverse contract fixture", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(origin + "/api/mcp/reverse"), {
        requestInit: {
          headers: {
            authorization: rpcHeaders.authorization,
            "x-loop55-run-id": run.id,
            "x-loop55-call-id": "contract-call",
          },
        },
      }),
    );
    const answer = client.callTool({
      name: tool.name,
      arguments: { query: "fixture" },
    });
    let pending: {
      id: string;
      runKey: string;
      requestKey: string;
      name: string;
      args: string;
    }[] = [];
    await expect
      .poll(async () => {
        const response = await request(
          base + "/pending?peerId=" + peerId,
          undefined,
          "GET",
          setup,
        );
        valid(workspaceApi.federationPending, response);
        pending = response.data;
        return pending.length;
      })
      .toBe(1);
    expect(pending[0]).toMatchObject({
      runKey: run.id,
      requestKey: "contract-call",
      name: tool.name,
      args: '{"query":"fixture"}',
    });
    await invalid(base + "/pending?peerId=" + peerId, {}, "GET", setup);
    const callId = pending[0].id;
    const claimed = await request(
      base + "/claim/" + callId,
      { peerId },
      "POST",
      setup,
    );
    valid(workspaceApi.federationClaim, claimed);
    expect(claimed.data.claimed).toBe(true);
    expect(
      (await request(base + "/claim/" + callId, { peerId }, "POST", setup)).data
        .claimed,
    ).toBe(false);
    await invalid(base + "/claim/" + callId, { peerId: 4 }, "POST", setup);
    await invalid(
      base + "/complete/" + callId,
      { peerId, state: "retry" },
      "POST",
      setup,
    );
    const completed = await request(
      base + "/complete/" + callId,
      {
        peerId,
        state: "completed",
        result: { content: [{ type: "text", text: "fixture result" }] },
      },
      "POST",
      setup,
    );
    valid(workspaceApi.federationComplete, completed);
    expect(await answer).toMatchObject({
      content: [{ type: "text", text: "fixture result" }],
    });
  } finally {
    await client.close();
  }
  const revoked = await request(base + "/revoke", { peerId }, "POST", setup);
  valid(workspaceApi.federationRevoke, revoked);
  expect(revoked.data).toEqual({ peerId, revoked: true });
  // Revoke intentionally accepts any body; malformed JSON remains a parser 400.
  const malformed = await request(
    base + "/revoke",
    undefined,
    "POST",
    setup,
    "{",
  );
  expect(malformed).toMatchObject({
    status: 400,
    data: { error: expect.any(String) },
  });
  expect(
    (await request(base + "/pending?peerId=" + peerId, undefined, "GET", setup))
      .status,
  ).toBe(403);
  expect(transition(run, "completed")).toBe(true);
}, 20000);
