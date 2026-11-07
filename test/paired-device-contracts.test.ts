import { createHost } from "./helpers/gateway.js";
import { afterAll, expect, it } from "vitest";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Host } from "../src/host";
import Database from "better-sqlite3";
import { workspaceApi } from "../src/shared/workspace-api";

const directory = mkdtempSync(join(tmpdir(), "loop-device-contracts-"));
const hosts: Host[] = [];
afterAll(async () => {
  await Promise.all(hosts.map((host) => host.close()));
  rmSync(directory, { recursive: true, force: true });
});
async function start(name: string, isolated = false) {
  const host = createHost(join(directory, name));
  hosts.push(host);
  host.workspace = {
    isolated,
    http: (_req, res) => {
      res.writeHead(404);
      res.end();
    },
    status: () => ({}),
    admin: async () => ({}),
    connect: () => () => {},
    originChanged: () => {},
  };
  await host.listen();
  return host;
}
async function pair(host: Host, name: string) {
  const paired = await fetch(host.origin + "/pair", {
    method: "POST",
    headers: { origin: host.origin, "content-type": "application/json" },
    body: JSON.stringify({
      secret: new URL(host.pair().url).hash.slice(6),
      name,
    }),
  });
  expect(paired.status).toBe(200);
  const cookie = paired.headers.get("set-cookie")!.split(";")[0];
  const session = await fetch(host.origin + "/session", {
    headers: { cookie },
  }).then((r) => r.json());
  return { cookie, "x-loop-csrf": session.csrf as string };
}
function send(
  host: Host,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
) {
  const bytes = body === undefined ? undefined : JSON.stringify(body);
  return new Promise<{ status: number; data: any }>((resolve, reject) => {
    const req = request(
      host.origin + "/api" + path,
      {
        method,
        headers: {
          origin: host.origin,
          ...(bytes === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(bytes),
              }),
          ...headers,
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode!, data: JSON.parse(text) });
          } catch (error) {
            reject(error);
          }
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(bytes);
  });
}

it("projects real paired devices and revokes only within their authorized host", async () => {
  const host = await start("primary"),
    other = await start("other", true);
  const first = await pair(host, "First phone"),
    second = await pair(host, "Second phone");
  const foreign = await pair(other, "Preview phone");
  const list = workspaceApi.workspaceDevices,
    revoke = workspaceApi.workspaceRevoke;
  expect((await send(host, list.path, {})).status).toBe(401);
  expect((await send(host, revoke.path, {}, { id: "unknown" })).status).toBe(
    401,
  );
  expect((await send(host, list.path, foreign)).status).toBe(401);
  expect((await send(other, list.path, first)).status).toBe(401);
  const result = await send(host, list.path, first);
  expect(result.status).toBe(200);
  const devices = list.response.parse(result.data);
  expect(devices.map((device) => device.name).sort()).toEqual([
    "First phone",
    "Second phone",
  ]);
  expect(result.data).toEqual(devices);
  const store = new Database(join(directory, "primary", "gateway-fixture.db"), {
    readonly: true,
  });
  const stored = store
    .prepare("SELECT id,name,expires,hash,csrf FROM devices ORDER BY rowid")
    .all() as {
    id: string;
    name: string;
    expires: number;
    hash: string;
    csrf: string;
  }[];
  store.close();
  for (const file of ["session.json", "devices.json"])
    expect(existsSync(join(directory, "primary", file))).toBe(false);
  expect(stored).toHaveLength(2);
  for (const device of stored) {
    expect(JSON.stringify(result.data)).not.toContain(device.hash);
    expect(JSON.stringify(result.data)).not.toContain(device.csrf);
  }
  expect(devices).toEqual(
    stored.map(({ id, name, expires }: (typeof devices)[number]) => ({
      id,
      name,
      expires,
    })),
  );
  const secondId = devices.find((device) => device.name === "Second phone")!.id;
  for (const headers of [
    { ...first, "x-loop-csrf": "invalid" },
    { ...first, origin: "https://foreign.example" },
  ])
    expect(
      (await send(host, revoke.path, headers, { id: secondId })).status,
    ).toBe(403);
  expect(await send(host, list.path, first, {}, "GET")).toMatchObject({
    status: 400,
    data: { error: expect.any(String) },
  });
  expect(await send(host, revoke.path, first, null)).toMatchObject({
    status: 400,
    data: { error: expect.any(String) },
  });
  const unchanged = await send(host, list.path, first);
  expect(unchanged.data).toEqual(devices);
  // Preserve the original string coercion and unknown-ID no-op, without revoking another host's device.
  expect(
    revoke.response.parse(
      (await send(host, revoke.path, first, { id: 42 })).data,
    ),
  ).toEqual({ ok: true });
  const foreignDevices = list.response.parse(
    (await send(other, list.path, foreign)).data,
  );
  expect(
    revoke.response.parse(
      (await send(host, revoke.path, first, { id: foreignDevices[0].id })).data,
    ),
  ).toEqual({ ok: true });
  expect((await send(other, list.path, foreign)).data).toEqual(foreignDevices);
  const removed = await send(host, revoke.path, first, {
    id: secondId,
    ignored: "private",
  });
  expect(removed).toEqual({
    status: 200,
    data: revoke.response.parse({ ok: true }),
  });
  expect((await send(host, list.path, second)).status).toBe(401);
  expect((await send(host, list.path, first)).data).toEqual(
    devices.filter((device) => device.id !== secondId),
  );
});
