process.env.LOOP_PROFILE = "companion";
import test from "node:test";
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
import { join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { WebSocket } from "ws";
import { Host } from "../src/host.js";
import { State, hash } from "../src/state.js";
import { Codex } from "../src/adapters/codex.js";
import { control } from "../src/host-control.js";
import { Tunnel, tunnelUrl } from "../src/tunnel.js";
import type { ServerMessage } from "../src/protocol.js";
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
async function until(fn: () => boolean) {
  const end = Date.now() + 5000;
  while (!fn()) {
    if (Date.now() > end) throw new Error("Timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("authenticated WS journey: atomic pairing, CSRF, native dedupe, replay, approval races, revoke", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loop-host-"));
  const audit = join(dir, "audit");
  process.env.LOOP_TEST_HARNESS = "codex";
  process.env.LOOP_TEST_AUDIT = audit;
  const host = new Host(dir, initial);
  host.adapter = new Codex(
    {
      harness: "codex",
      project: process.cwd(),
      executable: resolve("test/harness.mjs"),
      billing: "existing",
      version: "fixture",
    },
    host.emit,
  );
  const sockets: WebSocket[] = [];
  try {
    await host.listen();
    await host.adapter.start();
    host.emit({ type: "status", status: "ready" });
    const pair = host.pair();
    const token = new URLSearchParams(new URL(pair.url).hash.slice(1)).get(
      "pair",
    );
    const redeem = (secret = token, origin = host.origin) =>
      fetch(host.origin + "/pair", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ secret, name: "test phone" }),
      });
    assert.equal((await fetch(host.origin + "/session")).status, 401);
    assert.equal((await redeem(token, "https://evil.example")).status, 403);
    const pairResults = await Promise.all([redeem(), redeem()]);
    assert.deepEqual(pairResults.map((r) => r.status).sort(), [200, 403]);
    const cookie = pairResults
      .find((r) => r.ok)!
      .headers.get("set-cookie")!
      .split(";")[0];
    assert(
      pairResults
        .find((r) => r.ok)!
        .headers.get("set-cookie")!
        .includes("HttpOnly"),
    );
    const session = (await fetch(host.origin + "/session", {
      headers: { cookie },
    }).then((r) => r.json())) as { csrf: string; device: { id: string } };
    const rejected = new WebSocket(host.origin.replace("http", "ws") + "/ws", {
      headers: { Cookie: cookie, Origin: "https://evil.example" },
    });
    await new Promise<void>((r) => {
      rejected.on("unexpected-response", (_q, s) => {
        assert.equal(s.statusCode, 403);
        s.resume();
        rejected.terminate();
        r();
      });
      rejected.on("error", () => {});
    });
    const frames: any[] = [];
    const connect = async (query = "") => {
      const ws = new WebSocket(
        host.origin.replace("http", "ws") + "/ws" + query,
        { headers: { Cookie: cookie, Origin: host.origin } },
      );
      sockets.push(ws);
      ws.on("message", (b) => frames.push(JSON.parse(b.toString())));
      await new Promise<void>((r) => ws.on("open", r));
      return ws;
    };
    let ws = await connect();
    await until(() => frames.some((m) => m.snapshot));
    const c = {
      v: 1,
      id: randomUUID(),
      session: host.state.snapshot.session,
      type: "prompt",
      text: "approve",
    };
    ws.send(JSON.stringify({ csrf: "wrong", command: c }));
    await until(() => frames.some((m) => m.receipt?.status === "rejected"));
    assert.equal(host.state.receipts.size, 0);
    ws.send(JSON.stringify({ csrf: session.csrf, command: c }));
    await until(() => host.state.snapshot.requests.length === 1);
    ws.send(JSON.stringify({ csrf: session.csrf, command: c }));
    await until(() => frames.some((m) => m.receipt?.status === "accepted"));
    assert.equal(
      (await readFile(audit, "utf8")).trim().split("\n").length,
      1,
      "duplicate prompt never reaches native runtime",
    );
    const cursor = host.state.snapshot.cursor;
    const epoch = host.state.snapshot.epoch;
    ws.close();
    await new Promise<void>((r) => ws.once("close", () => r()));
    host.emit({
      type: "item",
      item: {
        id: "during-sleep",
        kind: "notice",
        text: "Desktop kept working",
      },
    });
    frames.length = 0;
    ws = await connect(`?epoch=${epoch}&cursor=${cursor}`);
    await until(() => frames.some((m) => m.event?.item?.id === "during-sleep"));
    assert(!frames.some((m) => m.snapshot), "retained cursor replays deltas");
    const answer = {
      v: 1,
      id: randomUUID(),
      session: c.session,
      type: "answer",
      request: "101",
      answer: { choice: "decline" },
    };
    ws.send(JSON.stringify({ csrf: session.csrf, command: answer }));
    ws.send(
      JSON.stringify({
        csrf: session.csrf,
        command: { ...answer, id: randomUUID(), answer: { choice: "accept" } },
      }),
    );
    await until(() => host.state.snapshot.status === "completed");
    assert.equal(host.state.snapshot.requests.length, 0);
    assert.equal(
      host.state.snapshot.items.filter((i) => i.kind === "assistant").at(-1)
        ?.text,
      "Fixture done",
    );
    const failed = { ...c, id: randomUUID(), text: "fail" };
    ws.send(JSON.stringify({ csrf: session.csrf, command: failed }));
    await until(() => host.state.snapshot.status === "failed");
    assert.equal(host.state.snapshot.recoverable, true);
    const followUp = { ...c, id: randomUUID(), text: "follow-up" };
    ws.send(JSON.stringify({ csrf: session.csrf, command: followUp }));
    await until(() => frames.some((m) => m.receipt?.id === followUp.id));
    assert.equal(
      frames.find((m) => m.receipt?.id === followUp.id)?.receipt.status,
      "accepted",
    );
    await until(() => host.state.snapshot.status === "completed");
    for (let i = 0; i < 520; i++)
      host.emit({ type: "delta", id: "large", text: "x" });
    frames.length = 0;
    await connect(`?epoch=${epoch}&cursor=0`);
    await until(() => frames.some((m) => m.snapshot));
    const closed = new Promise<number>((r) =>
      ws.on("close", (code) => r(code)),
    );
    await control(dir, "revoke", { id: session.device.id });
    assert.equal(await closed, 4003);
    assert.equal(
      (await fetch(host.origin + "/session", { headers: { cookie } })).status,
      401,
    );
    for (let i = 0; i < 20; i++) await redeem("a".repeat(43));
    assert.equal((await redeem("b".repeat(43))).status, 429);
    const persisted = JSON.parse(
      await readFile(join(dir, "session.json"), "utf8"),
    );
    assert(persisted.receipts.some((r: any) => r.id === c.id));
    assert(
      !(await readFile(join(dir, "devices.json"), "utf8")).includes(
        cookie.split("=")[1],
      ),
    );
  } finally {
    for (const s of sockets) s.terminate();
    await host.adapter.dispose();
    await host.close();
    await rm(dir, { recursive: true, force: true });
    delete process.env.LOOP_TEST_AUDIT;
    delete process.env.LOOP_TEST_HARNESS;
  }
});

test("bearer credentials: native pairing, session, cookie hand-off, CSRF, origin rules and rotation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loop-bearer-"));
  const host = new Host(dir, initial);
  host.workspace = {
    http: (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    },
    status: () => ({}),
    admin: async () => ({}),
    connect: () => () => {},
    originChanged: () => {},
  };
  const sockets: WebSocket[] = [];
  try {
    await host.listen();
    const fresh = () =>
      new URLSearchParams(new URL(host.pair().url).hash.slice(1)).get("pair")!;
    const redeem = (body: object, headers: Record<string, string> = {}) =>
      fetch(host.origin + "/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    assert.equal(
      (await redeem({ secret: fresh() })).status,
      403,
      "cookie pairing still requires the exact Origin",
    );
    const paired = await redeem({
      secret: fresh(),
      name: "Loop app",
      credential: "bearer",
    });
    assert.equal(paired.status, 200, "native pairing sends no Origin");
    assert.equal(paired.headers.get("set-cookie"), null);
    const { token, device } = (await paired.json()) as {
      token: string;
      device: { id: string; name: string };
    };
    assert(token.length >= 40);
    assert(
      !(await readFile(join(dir, "devices.json"), "utf8")).includes(token),
    );
    const auth = { Authorization: "Bearer " + token };
    const session = await fetch(host.origin + "/session", { headers: auth });
    assert.equal(session.status, 200);
    const { csrf } = (await session.json()) as { csrf: string };
    for (const header of ["Bearer " + "x".repeat(43), "Basic " + token])
      assert.equal(
        (
          await fetch(host.origin + "/session", {
            headers: { Authorization: header },
          })
        ).status,
        401,
      );

    const browser = await redeem({ secret: fresh() }, { Origin: host.origin });
    const cookie = browser.headers.get("set-cookie")!.split(";")[0];
    assert(
      !JSON.stringify(await browser.json()).includes(cookie.split("=")[1]),
    );
    const cookieCsrf = (
      (await fetch(host.origin + "/session", { headers: { cookie } }).then(
        (r) => r.json(),
      )) as { csrf: string }
    ).csrf;
    assert.equal(
      (
        await fetch(host.origin + "/session", {
          headers: { cookie, Authorization: "Bearer " + "x".repeat(43) },
        })
      ).status,
      401,
      "an Authorization header is authoritative over the cookie",
    );

    const write = (headers: Record<string, string>) =>
      fetch(host.origin + "/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: "{}",
      });
    assert.equal((await write({ ...auth, "x-loop-csrf": csrf })).status, 200);
    assert.equal(
      (await write(auth)).status,
      403,
      "bearer writes still need CSRF",
    );
    assert.equal(
      (await write({ cookie, "x-loop-csrf": cookieCsrf })).status,
      403,
      "cookie writes still need Origin",
    );
    assert.equal(
      (await write({ cookie, "x-loop-csrf": cookieCsrf, Origin: host.origin }))
        .status,
      200,
    );

    const wsUrl = host.origin.replace("http", "ws") + "/ws";
    const bearerSocket = new WebSocket(wsUrl, { headers: auth });
    sockets.push(bearerSocket);
    await new Promise<void>((r, j) => {
      bearerSocket.on("open", () => r());
      bearerSocket.on("unexpected-response", (_q, s) =>
        j(new Error("bearer upgrade rejected: " + s.statusCode)),
      );
    });
    const cookieSocket = new WebSocket(wsUrl, { headers: { cookie } });
    sockets.push(cookieSocket);
    await new Promise<void>((r) => {
      cookieSocket.on("unexpected-response", (_q, s) => {
        assert.equal(s.statusCode, 403, "cookie upgrade still needs Origin");
        s.resume();
        r();
      });
      cookieSocket.on("error", () => {});
    });

    const opened = await fetch(host.origin + "/session/open", {
      headers: auth,
    });
    assert.equal(opened.status, 200);
    const handed = opened.headers.get("set-cookie")!;
    assert(
      handed.startsWith(`loop_local=${token};`) && handed.includes("HttpOnly"),
    );
    assert.match(
      await opened.text(),
      /http-equiv="refresh" content="0;url=\/"/,
    );
    // The handed-off cookie lives exactly as long as the device pairing.
    const maxAge = (cookie: string) =>
      Number(/Max-Age=(\d+)/.exec(cookie)?.[1]);
    assert(Math.abs(maxAge(handed) - 7 * 86400) <= 2, handed);
    const now = Date.now;
    Date.now = () => now() + 86400000;
    try {
      const later = await fetch(host.origin + "/session/open", {
        headers: auth,
      });
      assert(
        Math.abs(maxAge(later.headers.get("set-cookie")!) - 6 * 86400) <= 2,
      );
    } finally {
      Date.now = now;
    }
    for (const headers of [
      {},
      { Authorization: "Bearer " + "x".repeat(43) },
    ] as Record<string, string>[])
      assert.equal(
        (await fetch(host.origin + "/session/open", { headers })).headers.get(
          "set-cookie",
        ),
        null,
      );

    const listed = (await control(dir, "devices")) as {
      id: string;
      name: string;
    }[];
    assert(listed.some((d) => d.id === device.id && d.name === "Loop app"));
    host.setOrigin("https://rotated.example");
    assert.deepEqual(
      await control(dir, "devices"),
      [],
      "rotation revokes bearer and cookie devices alike",
    );
  } finally {
    for (const s of sockets) s.terminate();
    await host.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("malformed pairing requests count toward the pairing rate limit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loop-pair-limit-"));
  const host = new Host(dir, initial);
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

test("state retention and durable unknown command outcomes never imply a retry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loop-state-"));
  try {
    const state = new State(dir, initial);
    const id = randomUUID();
    assert.equal(state.begin(id, hash("prompt")), undefined);
    assert.equal(state.begin(id, hash("prompt"))?.status, "unknown");
    assert.throws(() => state.begin(id, hash("different")), /reused/);
    for (let i = 0; i < 800; i++)
      state.apply({
        type: "item",
        item: { id: String(i), kind: "tool", text: "x".repeat(70000) },
      });
    assert(state.snapshot.items.length < 200);
    assert(state.events.length < 512);
    assert.equal(state.replay("wrong epoch", 0), undefined);
    assert.equal(state.replay(state.snapshot.epoch, 0), undefined);
    const disk = JSON.parse(await readFile(join(dir, "session.json"), "utf8"));
    assert.equal(disk.receipts[0].status, "unknown");
  } finally {
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
  const host = new Host(dir, initial);
  const now = Date.now;
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
    Date.now = () => now() + 121000;
    assert.equal((await redeem(headers)).status, 403);
    Date.now = now;
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
    Date.now = () => now() + 8 * 86400000;
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
    Date.now = now;
    await host.close();
    await rm(dir, { recursive: true, force: true });
  }
});
