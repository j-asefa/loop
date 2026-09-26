// Imports mobile/, so .dockerignore excludes this file from the server image.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { Host } from "../src/host.js";
import { control } from "../src/host-control.js";
import {
  check,
  openUrl,
  pair,
  parsePairingCode,
  sameOrigin,
} from "../mobile/src/connection.js";

const initial = {
  harness: "codex" as const,
  version: "fixture",
  project: "/fixture",
  billing: { mode: "existing" as const, description: "fixture only" },
  capabilities: {
    approvals: true,
    questions: true,
    resume: true,
    liveAttach: false,
    terminal: false,
  },
};
const secret = "A".repeat(43);

test("the Loop app accepts only loop pair codes", () => {
  assert.deepEqual(
    parsePairingCode(`https://one-two.trycloudflare.com/#pair=${secret}\n`),
    { origin: "https://one-two.trycloudflare.com", secret },
  );
  for (const code of [
    "not a url",
    `http://one-two.trycloudflare.com/#pair=${secret}`,
    `https://user:pw@one-two.trycloudflare.com/#pair=${secret}`,
    `https://one-two.trycloudflare.com/other#pair=${secret}`,
    `https://one-two.trycloudflare.com/?x=1#pair=${secret}`,
    "https://one-two.trycloudflare.com/#pair=short",
    `https://one-two.trycloudflare.com/#pair=${"A".repeat(42)}!`,
  ])
    assert.throws(() => parsePairingCode(code), /pairing code/, code);
  assert(sameOrigin("https://a.example/x?y", "https://a.example"));
  assert(!sameOrigin("https://a.example.evil/x", "https://a.example"));
  assert(!sameOrigin("garbage", "https://a.example"));
});

test("the Loop app is connected only to its own session on its own origin", async () => {
  const pairing = {
    origin: "https://one-two.trycloudflare.com",
    token: "t",
    deviceId: "device-1",
  };
  // fetch reports the final URL after redirects in `url`.
  const reply =
    (status: number, body: string, url = pairing.origin + "/session") =>
    async () =>
      Object.defineProperty(new Response(body, { status }), "url", {
        value: url,
      });
  const session = (id: string) => JSON.stringify({ csrf: "c", device: { id } });
  assert.equal(
    await check(pairing, reply(200, session("device-1"))),
    "connected",
  );
  assert.equal(await check(pairing, reply(401, "{}")), "revoked");
  for (const [name, fetchImpl] of [
    ["fallback page", reply(200, "<!doctype html><title>Sign in</title>")],
    ["another device", reply(200, session("device-2"))],
    [
      "redirected elsewhere",
      reply(200, session("device-1"), "https://gateway.example/session"),
    ],
    ["server error", reply(502, "Bad gateway")],
  ] as const)
    assert.equal(await check(pairing, fetchImpl), "unreachable", name);
});

// Sends requests for the public tunnel origin to the host's loopback port with
// the public Host header, as cloudflared does. Node's fetch can't set Host.
function viaTunnel(loopback: string): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    return new Promise<Response>((resolve, reject) => {
      const req = httpRequest(
        new URL(url.pathname + url.search, loopback),
        {
          method: init.method ?? "GET",
          headers: {
            ...(init.headers as Record<string, string>),
            Host: url.host,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const headers = new Headers();
            for (const [k, v] of Object.entries(res.headers))
              for (const value of [v ?? []].flat()) headers.append(k, value);
            resolve(
              Object.defineProperty(
                new Response(Buffer.concat(chunks), {
                  status: res.statusCode,
                  headers,
                }),
                "url",
                { value: url.href },
              ),
            );
          });
        },
      );
      req.on("error", reject);
      init.signal?.addEventListener("abort", () =>
        req.destroy(new Error("aborted")),
      );
      req.end(init.body as string | undefined);
    });
  }) as typeof fetch;
}

test("the Loop app pairs from a real loop pair code, checks health and detects revocation and a dead origin", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loop-mobile-"));
  const host = new Host(dir, initial);
  try {
    await host.listen();
    const tunnel = viaTunnel(host.origin);
    host.setOrigin("https://loop-test.trycloudflare.com");
    // The exact URL the CLI turns into a QR code, parsed as the app does.
    const code = parsePairingCode(host.pair().url);
    assert.equal(code.origin, "https://loop-test.trycloudflare.com");
    const pairing = await pair(code, "Loop app (iOS)", tunnel);
    assert.equal(pairing.origin, code.origin);
    await assert.rejects(
      pair(code, "Loop app (iOS)", tunnel),
      /expired, invalid or already used/,
    );
    assert.equal(await check(pairing, tunnel), "connected");
    assert.equal(openUrl(pairing), code.origin + "/session/open");
    const opened = await tunnel(openUrl(pairing), {
      headers: { Authorization: "Bearer " + pairing.token },
    });
    const cookie = opened.headers.get("set-cookie") ?? "";
    assert(cookie.startsWith(`__Host-loop=${pairing.token};`), cookie);
    assert.match(cookie, /Secure; SameSite=Lax; Path=\//);

    await control(dir, "revoke", { id: pairing.deviceId });
    assert.equal(await check(pairing, tunnel), "revoked");

    await host.close();
    assert.equal(await check(pairing, tunnel, 2000), "unreachable");
    await assert.rejects(
      pair(code, "Loop app (iOS)", tunnel),
      /Couldn't reach your computer/,
    );
  } finally {
    await host.close();
    await rm(dir, { recursive: true, force: true });
  }
});
