import { createHost } from "./helpers/gateway.js";
import { DevicePairing } from "../src/server/device-pairing.js";
import { applyMigrations } from "../src/server/migrations.js";
import { probeProof } from "../src/connection.js";
import test from "node:test";
import Database from "better-sqlite3";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  mkdir,
  writeFile,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, createHmac } from "node:crypto";
import { request as httpRequest } from "node:http";
import { WebSocket } from "ws";
import { control } from "../src/host-control.js";
import { Tunnel, tunnelUrl } from "../src/tunnel.js";
test("cookie-only pairing enforces Origin and CSRF and rejects bearer authentication", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loop-cookie-"));
  const host = createHost(dir);
  host.workspace = {
    http: (_req, res) => {
      res.writeHead(200);
      res.end("{}");
    },
    status: () => ({}),
    admin: async () => ({}),
    connect: () => () => {},
    originChanged: () => {},
  };
  try {
    await host.listen();
    const secret = new URL(host.pair().url).hash.slice(6);
    const redeem = (credential?: string, origin?: string) =>
      fetch(host.origin + "/pair", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(origin ? { Origin: origin } : {}),
        },
        body: JSON.stringify({ secret, credential }),
      });
    assert.equal((await redeem("bearer", host.origin)).status, 400);
    assert.equal((await redeem()).status, 403);
    assert.equal((await redeem("cookie", "https://evil.example")).status, 403);
    const paired = await redeem("cookie", host.origin);
    assert.equal(
      paired.status,
      200,
      "rejected requests do not consume the pairing code",
    );
    assert.deepEqual(await paired.json(), { paired: true });
    const cookie = paired.headers.get("set-cookie")!.split(";")[0];
    const token = cookie.slice(cookie.indexOf("=") + 1);
    assert(
      !(await readFile(join(dir, "gateway-fixture.db"))).includes(
        Buffer.from(token),
      ),
    );
    const session = (await fetch(host.origin + "/session", {
      headers: { cookie },
    }).then((r) => r.json())) as any;
    const auth = { Authorization: "Bearer " + token };
    assert.equal(
      (await fetch(host.origin + "/session", { headers: auth })).status,
      403,
    );
    const write = (headers: Record<string, string>) =>
      fetch(host.origin + "/api/agents", {
        method: "POST",
        headers,
        body: "{}",
      });
    assert.equal(
      (
        await write({
          ...auth,
          Origin: host.origin,
          "x-loop-csrf": session.csrf,
        })
      ).status,
      403,
    );
    assert.equal((await write({ cookie, Origin: host.origin })).status, 403);
    assert.equal(
      (await write({ cookie, "x-loop-csrf": session.csrf })).status,
      403,
    );
    assert.equal(
      (await write({ cookie, ...auth, "x-loop-csrf": session.csrf })).status,
      403,
    );
    assert.equal(
      (
        await write({
          cookie,
          Origin: "https://evil.example",
          "x-loop-csrf": session.csrf,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await write({
          cookie,
          Origin: host.origin,
          "x-loop-csrf": session.csrf,
        })
      ).status,
      200,
    );
    for (const headers of [
      auth,
      { ...auth, Origin: host.origin },
      { cookie },
      { cookie, ...auth },
    ]) {
      const ws = new WebSocket(host.origin.replace("http", "ws") + "/ws", {
        headers,
      });
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => {
          ws.terminate();
          reject(new Error("Unauthorized socket opened"));
        });
        ws.on("unexpected-response", (_req, res) => {
          assert.equal(res.statusCode, 403);
          res.resume();
          ws.terminate();
          resolve();
        });
        ws.on("error", () => {});
      });
    }
    const devices = await control(dir, "devices");
    host.setOrigin("https://rotated.example");
    assert.deepEqual(
      await control(dir, "devices"),
      devices,
      "rotation preserves trust",
    );
  } finally {
    await host.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("malformed pairing requests count toward the pairing rate limit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loop-pair-limit-"));
  const host = createHost(dir);
  try {
    await host.listen();
    const post = (body: string) =>
      fetch(host.origin + "/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: host.origin },
        body,
      });
    for (let i = 0; i < 20; i++) assert.equal((await post("{")).status, 400);
    const secret = new URLSearchParams(
      new URL(host.pair().url).hash.slice(1),
    ).get("pair")!;
    assert.equal((await post(JSON.stringify({ secret }))).status, 429);
  } finally {
    await host.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("only complete Quick Tunnel hostnames are accepted", () => {
  assert.equal(
    tunnelUrl("| https://one-two-three.trycloudflare.com |"),
    "https://one-two-three.trycloudflare.com",
  );
  for (const text of [
    "https://one-two.trycloudflare.com.evil.org",
    "http://one-two.trycloudflare.com",
    "https://evil.org",
    "https://one-two.trycloudflare.com/steal",
  ])
    assert.equal(tunnelUrl(text), undefined);
});

test("stopping during helper lookup cancels tunnel startup", async () => {
  const assetHashes: Record<string, string> = {
    "linux-x64":
      "77e26d8d900e0b8469f416239d14b5f296525fdf79fee6f511ef55609e3fbac2",
    "linux-arm64":
      "aaeb2d7d0da3614634c7e03ab13487a1522c2e79165ed2929cfe23d5e95b326d",
    "darwin-x64":
      "d1155d0837487f261183b15c1eab6c4ebcad9dc49b94675f1524c3564cea3977",
    "darwin-arm64":
      "587c2cfb1c230fe36c7fa7727da78be459dae028cabe8c001291999350f07095",
  };
  const assetHash = assetHashes[`${process.platform}-${process.arch}`];
  if (!assetHash) return;
  const dir = await mkdtemp(join(tmpdir(), "loop-tunnel-"));
  try {
    const helperDir = join(dir, "helpers", "2026.9.3");
    await mkdir(helperDir, { recursive: true });
    const binary = Buffer.from("fixture, never executed");
    await writeFile(join(helperDir, "cloudflared"), binary);
    await writeFile(
      join(helperDir, "manifest.json"),
      JSON.stringify({
        assetHash,
        binaryHash: createHash("sha256").update(binary).digest("hex"),
      }),
    );
    const tunnel = new Tunnel(dir, 12345, () => {});
    const starting = tunnel.start();
    await tunnel.stop();
    await assert.rejects(starting, /startup cancelled/);
    await assert.rejects(stat(join(dir, "quick-tunnel.yml")), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pairing TTL, exact Host, missing Origin and secure-cookie semantics", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loop-pair-"));
  const db = new Database(join(dir, "trust.db"));
  applyMigrations(db);
  let now = Date.now();
  let elapsed = 0;
  const trust = new DevicePairing(
    db,
    "fixture-owner",
    dir,
    () => now,
    () => elapsed,
  );
  const host = createHost(dir, trust);
  try {
    await host.listen();
    const local = host.origin;
    host.setOrigin("https://paired.example");
    const token = new URLSearchParams(
      new URL(host.pair().url).hash.slice(1),
    ).get("pair");
    const headers = {
      Host: "paired.example",
      Origin: "https://paired.example",
      "Content-Type": "application/json",
    };
    // Node fetch forbids overriding Host; use the raw HTTP client to simulate a tunnel.
    const send = (
      path: string,
      h: Record<string, string>,
      body?: string,
    ): Promise<{ status: number; cookie: string }> =>
      new Promise((resolve, reject) => {
        const req = httpRequest(
          local + path,
          { method: body ? "POST" : "GET", headers: h },
          (res) => {
            res.resume();
            res.on("end", () =>
              resolve({
                status: res.statusCode!,
                cookie: res.headers["set-cookie"]?.[0] ?? "",
              }),
            );
          },
        );
        req.on("error", reject);
        req.end(body);
      });
    const redeem = (h: Record<string, string>) =>
      send("/pair", h, JSON.stringify({ secret: token }));
    assert.equal(
      (await redeem({ ...headers, Host: "attacker.example" })).status,
      403,
    );
    assert.equal(
      (
        await redeem({
          Host: headers.Host,
          "Content-Type": headers["Content-Type"],
        })
      ).status,
      403,
    );
    now += 121000;
    elapsed += 121000;
    assert.equal((await redeem(headers)).status, 403);
    const fresh = new URLSearchParams(
      new URL(host.pair().url).hash.slice(1),
    ).get("pair");
    const response = await send(
      "/pair",
      headers,
      JSON.stringify({ secret: fresh }),
    );
    assert.equal(response.status, 200);
    const cookie = response.cookie;
    assert(cookie.startsWith("__Host-loop="));
    assert(cookie.includes("Secure;"));
    assert(cookie.includes("SameSite=Lax"));
    now += 366 * 86400000;
    assert.equal(
      (
        await send("/session", {
          Host: "paired.example",
          Cookie: cookie.split(";")[0],
        })
      ).status,
      401,
    );
  } finally {
    await host.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("device trust survives restart; explicit revocation survives the next restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loop-device-restart-"));
  let host = createHost(dir);
  try {
    await host.listen();
    const secret = new URL(host.pair().url).hash.slice(6);
    const paired = await fetch(host.origin + "/pair", {
      method: "POST",
      headers: { Origin: host.origin, "Content-Type": "application/json" },
      body: JSON.stringify({
        secret,
        name: "persistent phone",
      }),
    });
    assert.equal(paired.status, 200);
    const cookie = paired.headers.get("set-cookie")!.split(";")[0];
    await host.close();
    host = createHost(dir);
    await host.listen();
    assert.equal(
      (
        await fetch(host.origin + "/session", {
          headers: { cookie },
        })
      ).status,
      200,
    );
    const devices = await control(dir, "devices");
    await control(dir, "revoke", { id: devices[0].id });
    await host.close();
    host = createHost(dir);
    await host.listen();
    assert.equal(
      (
        await fetch(host.origin + "/session", {
          headers: { cookie },
        })
      ).status,
      401,
    );
  } finally {
    await host.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("device renewal persists but cannot exceed its fixed maximum lifetime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loop-device-cap-"));
  let host = createHost(dir);
  try {
    await host.listen();
    const secret = new URL(host.pair().url).hash.slice(6);
    const response = await fetch(host.origin + "/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: host.origin },
      body: JSON.stringify({ secret }),
    });
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie")!.split(";")[0];
    await host.close();
    const file = join(dir, "gateway-fixture.db");
    let store = new Database(file);
    const cap = Date.now() + 120000;
    store
      .prepare("UPDATE devices SET expires=?,max_expires=?")
      .run(Date.now() + 60000, cap);
    store.close();
    host = createHost(dir);
    await host.listen();
    assert.equal(
      (
        await fetch(host.origin + "/session", {
          headers: { cookie },
        })
      ).status,
      200,
    );
    await host.close();
    store = new Database(file);
    const renewed = store
      .prepare("SELECT expires,max_expires AS maxExpires FROM devices")
      .get() as { expires: number; maxExpires: number };
    assert.equal(renewed.expires, cap);
    assert.equal(renewed.maxExpires, cap);
    store
      .prepare("UPDATE devices SET expires=?,max_expires=?")
      .run(Date.now() - 1, Date.now() - 1);
    store.close();
    host = createHost(dir);
    await host.listen();
    assert.equal(
      (
        await fetch(host.origin + "/session", {
          headers: { cookie },
        })
      ).status,
      401,
    );
  } finally {
    await host.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the private host accepts an existing connection service's probe and signed domain", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loop-probe-upgrade-"));
  const socketPath = join(dir, "app.sock");
  const host = createHost(dir);
  const nonce = "a".repeat(20);
  try {
    await host.listen({
      socket: socketPath,
      probe: (value) =>
        probeProof("fixture-lease", "fixture-instance", 1, value),
    });
    for (const prefix of ["/__loop"]) {
      const response = await new Promise<{ status: number; body: string }>(
        (resolve, reject) => {
          const req = httpRequest(
            { socketPath, path: prefix + "/backend-probe?nonce=" + nonce },
            (res) => {
              let body = "";
              res.on("data", (part) => (body += part));
              res.on("end", () => resolve({ status: res.statusCode!, body }));
            },
          );
          req.on("error", reject);
          req.end();
        },
      );
      assert.equal(response.status, 200);
      assert.equal(
        JSON.parse(response.body).proof,
        createHmac("sha256", "fixture-lease")
          .update(`loop-backend-probe\nfixture-instance\n1\n${nonce}`)
          .digest("hex"),
      );
    }
  } finally {
    await host.close();
    await rm(dir, { recursive: true, force: true });
  }
});
