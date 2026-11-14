import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, request, type Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, chmod } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import {
  BackendLease,
  backendSocketPath,
  connectionControl,
  probeProof,
  readConnectionRecord,
  type ConnectionRecord,
} from "../src/connection.js";
import { alive } from "../src/process-records.js";
import { until } from "./helpers.js";

const FAKE = resolve("test/fixtures/fake-cloudflared.mjs");

async function service(env: Record<string, string> = {}, existing?: string) {
  await mkdir(".tmp", { recursive: true });
  await chmod(FAKE, 0o755);
  const dir =
    existing ?? (await mkdtemp(join(resolve(".tmp"), "loop-connection-")));
  const tunnels = join(dir, "tunnels.log");
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/connection-daemon.ts",
      "--dir",
      dir,
      "--root",
      dir,
    ],
    {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        ...process.env,
        LOOP_TEST_CLOUDFLARED: FAKE,
        LOOP_TEST_TUNNEL_LOG: tunnels,
        ...env,
      },
    },
  );
  let output = "";
  child.stdout!.on("data", (b) => (output += b));
  child.stderr!.on("data", (b) => (output += b));
  const ready = await new Promise<any>((resolve, reject) => {
    child.once("message", resolve);
    child.once("exit", () => reject(new Error("service exited: " + output)));
  });
  assert.equal(ready.ready, true, output);
  const record = readConnectionRecord(dir)!;
  const control = (op: string, body: unknown = {}) =>
    connectionControl(record, op, body);
  const hello = () => control("hello");
  const cleanup = async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((r) => child.once("exit", r));
    }
    for (const line of existsSync(tunnels)
      ? readFileSync(tunnels, "utf8").trim().split("\n")
      : [])
      if (alive(Number(line.split(" ")[0])))
        process.kill(Number(line.split(" ")[0]), "SIGKILL");
    await rm(dir, { recursive: true, force: true });
  };
  return {
    dir,
    child,
    record,
    control,
    hello,
    origin: ready.origin as string,
    cleanup,
    tunnels,
  };
}

/** A minimal application launch: proves its lease on a private socket. */
async function backend(
  record: ConnectionRecord,
  control: (op: string, body?: unknown) => Promise<any>,
  handler: (req: any, res: any) => void = (req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        host: req.headers.host,
        cookie: req.headers.cookie ?? null,
        path: req.url,
        probe: req.headers["x-loop-probe"] ?? null,
        upgrade: req.headers.upgrade ?? null,
        te: req.headers["transfer-encoding"] ?? null,
      }),
    );
  },
) {
  const lease = await control("lease");
  const socket = backendSocketPath(join(record.control, ".."));
  const seen: string[] = [];
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/__loop/backend-probe?")) {
      const nonce = new URL(req.url, "http://x").searchParams.get("nonce")!;
      res.end(
        JSON.stringify({
          proof: probeProof(
            lease.lease,
            lease.instance,
            lease.generation,
            nonce,
          ),
        }),
      );
      return;
    }
    seen.push(`${req.method} ${req.url}`);
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(socket, r));
  const ids = { generation: lease.generation, lease: lease.lease };
  return {
    server,
    socket,
    lease,
    ids,
    seen,
    register: () => control("register", { ...ids, socket: basename(socket) }),
  };
}

function relay(
  port: number,
  origin: string,
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: Buffer | string } = {},
) {
  return new Promise<{ status: number; headers: any; body: Buffer }>(
    (resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          method,
          path,
          headers: { host: new URL(origin).host, ...options.headers },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (b) => chunks.push(b));
          res.on("end", () =>
            resolve({
              status: res.statusCode!,
              headers: res.headers,
              body: Buffer.concat(chunks),
            }),
          );
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end(options.body);
    },
  );
}
const close = (server: Server) =>
  new Promise((r) => {
    server.closeAllConnections();
    server.close(r);
  });

test("the private control socket authenticates callers and only forwards to a verified launch", async () => {
  const s = await service();
  try {
    const record = s.record;
    assert.equal(
      (await readFile(join(s.dir, "connection.json"), "utf8")).length > 0,
      true,
    );
    await assert.rejects(
      connectionControl({ ...record, token: "x".repeat(43) }, "hello"),
      /authentication required/,
    );
    await assert.rejects(
      connectionControl(
        { ...record, token: "é".repeat(record.token.length) },
        "hello",
      ),
      (error: any) =>
        error.status === 403 && /authentication required/.test(error.message),
    );
    const raw = (body: string, path = "/v1/hello", method = "POST") =>
      new Promise<number>((resolve, reject) => {
        const req = request(
          {
            socketPath: record.control,
            path,
            method,
            headers: { authorization: "Bearer " + record.token },
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode!));
            res.on("error", reject);
          },
        );
        req.on("error", reject);
        req.end(body);
      });
    assert.equal(
      await raw(""),
      200,
      "connection control accepts an empty body without a content-type header",
    );
    assert.equal(await raw(JSON.stringify("x".repeat(15998))), 200);
    assert.equal(
      await raw(JSON.stringify("é".repeat(8000))),
      400,
      "the limit counts bytes, not characters",
    );
    assert.equal(await raw("{"), 400);
    assert.equal(await raw("{}", "/v1/unknown"), 404);
    assert.equal(await raw("{}", "/v1/hello", "GET"), 403);
    const withOrigin = await new Promise<number>((resolve) => {
      const req = request(
        {
          socketPath: record.control,
          path: "/v1/hello",
          method: "POST",
          headers: {
            authorization: "Bearer " + record.token,
            origin: "https://evil.example",
          },
        },
        (res) => resolve(res.statusCode!),
      );
      req.end("{}");
    });
    assert.equal(withOrigin, 403);
    const hello = await s.hello();
    assert.equal(hello.tunnel.state, "ready");
    assert.equal(hello.origin, s.origin);
    assert.equal(hello.backend.state, "none");
    // Nothing secret leaves through hello.
    assert.doesNotMatch(JSON.stringify(hello), new RegExp(record.token));
    const stat = (await import("node:fs")).statSync;
    assert.equal(stat(join(s.dir, "connection.json")).mode & 0o777, 0o600);
    assert.equal(stat(record.control).mode & 0o777, 0o600);
    const {
      relay: { port },
    } = await s.hello();
    const page = await relay(port, s.origin, "GET", "/", {
      headers: { accept: "text/html" },
    });
    assert.equal(page.status, 503);
    assert.match(page.body.toString(), /Loop is reconnecting/);
    assert.equal(page.headers["x-loop-unavailable"], "restarting");

    // Same directory, same user, but it can't answer the lease's proof.
    const lease = await s.control("lease");
    const impostorPath = backendSocketPath(join(s.record.control, ".."));
    const impostorSeen: any[] = [];
    const impostor = createServer((req, res) => {
      impostorSeen.push({ url: req.url, cookie: req.headers.cookie });
      res.end(JSON.stringify({ proof: "f".repeat(64) }));
    });
    await new Promise<void>((r) => impostor.listen(impostorPath, r));
    await assert.rejects(
      s.control("register", {
        generation: lease.generation,
        lease: lease.lease,
        socket: basename(impostorPath),
      }),
      /failed verification/,
    );
    await assert.rejects(
      s.control("register", {
        generation: lease.generation,
        lease: lease.lease,
        socket: "../../etc/passwd",
      }),
      /Invalid application socket/,
    );
    const denied = await relay(port, s.origin, "POST", "/api/runs", {
      headers: {
        cookie: "__Host-loop=secret",
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.equal(denied.status, 503);
    assert.deepEqual(
      impostorSeen.map((r) => r.cookie),
      [undefined],
      "only the cookie-less probe reached it",
    );
    await close(impostor);

    const first = await backend(s.record, s.control);
    await first.register();
    const second = await backend(s.record, s.control);
    await second.register();
    const served = await relay(port, s.origin, "GET", "/api/x");
    assert.equal(
      served.status,
      200,
      "only the newly registered launch receives traffic",
    );
    assert.deepEqual(first.seen, []);
    assert.deepEqual(second.seen, ["GET /api/x"]);
    await s.control("withdraw", second.ids);
    assert.equal((await relay(port, s.origin, "GET", "/api/x")).status, 503);
    await close(first.server);
    await close(second.server);
  } finally {
    await s.cleanup();
  }
});

test("the relay preserves Host and cookies, strips private and hop-by-hop fields, and blocks the probe path", async () => {
  const s = await service();
  try {
    const {
      relay: { port },
    } = await s.hello();
    const app = await backend(s.record, s.control);
    await app.register();
    const answer = await relay(port, s.origin, "GET", "/api/echo?q=1", {
      headers: {
        cookie: "__Host-loop=abc",
        "x-loop-probe": "1",
        connection: "keep-alive, x-drop",
        "x-drop": "1",
      },
    });
    const echoed = JSON.parse(answer.body.toString());
    assert.equal(echoed.host, new URL(s.origin).host);
    assert.equal(echoed.cookie, "__Host-loop=abc");
    assert.equal(echoed.path, "/api/echo?q=1");
    assert.equal(echoed.probe, null);
    for (const path of [
      "/__loop/backend-probe?nonce=" + "a".repeat(20),
      "/__loop",
      "/__loop/backend-probe?nonce=" + "a".repeat(20),
      "/__loop",
    ])
      assert.equal((await relay(port, s.origin, "GET", path)).status, 404);
    assert.deepEqual(app.seen, ["GET /api/echo?q=1"]);
    await close(app.server);
  } finally {
    await s.cleanup();
  }
});

test("uploads and downloads stream, WebSockets upgrade, and an interrupted mutation is reported, never replayed", async () => {
  const s = await service();
  try {
    const {
      relay: { port },
    } = await s.hello();
    const download = randomBytes(4 * 1024 * 1024);
    let mutations = 0;
    const app = await backend(s.record, s.control, async (req, res) => {
      if (req.url === "/upload") {
        const hash = createHash("sha256");
        let size = 0;
        for await (const chunk of req) {
          hash.update(chunk);
          size += chunk.length;
        }
        res.end(JSON.stringify({ size, sha: hash.digest("hex") }));
      } else if (req.url === "/download") {
        res.setHeader("content-type", "application/octet-stream");
        res.end(download);
      } else if (req.url === "/mutate") {
        mutations++;
        // The application dies after admitting the request.
        req.socket.destroy();
      } else res.end("{}");
    });
    const wss = new WebSocketServer({ server: app.server });
    wss.on("connection", (socket, req) => {
      socket.send(
        JSON.stringify({ host: req.headers.host, cookie: req.headers.cookie }),
      );
      socket.on("message", (data) => socket.send("echo:" + data));
    });
    await app.register();
    const body = randomBytes(6 * 1024 * 1024);
    const uploaded = JSON.parse(
      (
        await relay(port, s.origin, "POST", "/upload", {
          headers: { "content-type": "multipart/form-data; boundary=x" },
          body,
        })
      ).body.toString(),
    );
    assert.equal(uploaded.size, body.length);
    assert.equal(uploaded.sha, createHash("sha256").update(body).digest("hex"));
    const downloaded = await relay(port, s.origin, "GET", "/download");
    assert(downloaded.body.equals(download));

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { host: new URL(s.origin).host, cookie: "__Host-loop=abc" },
    });
    const messages: string[] = [];
    ws.on("message", (b) => messages.push(b.toString()));
    await new Promise((r) => ws.once("open", r));
    ws.send("ping");
    await until(() => messages.length === 2);
    assert.deepEqual(JSON.parse(messages[0]), {
      host: new URL(s.origin).host,
      cookie: "__Host-loop=abc",
    });
    assert.equal(messages[1], "echo:ping");

    const interrupted = await relay(port, s.origin, "POST", "/mutate", {
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(interrupted.status, 502);
    assert.equal(interrupted.headers["x-loop-outcome"], "unknown");
    assert.equal(mutations, 1, "the relay never resends a request");

    // Withdrawal ends this launch's forwarding; its open socket drains, then closes.
    await s.control("withdraw", app.ids);
    assert.equal((await relay(port, s.origin, "GET", "/download")).status, 503);
    const refused = await new Promise<number>((resolve) => {
      const late = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        headers: { host: new URL(s.origin).host },
      });
      late.on("unexpected-response", (_req, res) => resolve(res.statusCode!));
      late.on("error", () => {});
    });
    assert.equal(refused, 503);
    ws.close();
    wss.close();
    await close(app.server);
  } finally {
    await s.cleanup();
  }
});

test("a dead or silent launch stops receiving traffic; shutdown stops cloudflared and clears records", async () => {
  const s = await service({ LOOP_TEST_LEASE_TIMEOUT_MS: "1500" });
  try {
    const {
      relay: { port },
      tunnel,
    } = await s.hello();
    const app = await backend(s.record, s.control);
    await app.register();
    assert.equal((await relay(port, s.origin, "GET", "/api/a")).status, 200);
    // No heartbeats: the lease expires even though the socket still answers.
    const deadline = Date.now() + 5000;
    let status = 200;
    while (status === 200 && Date.now() < deadline) {
      status = (await relay(port, s.origin, "GET", "/api/a")).status;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(status, 503);
    assert.equal((await s.hello()).backend.state, "none");
    // The stalled launch returns: its heartbeat reports it unregistered, and it
    // must pass the probe again before traffic resumes.
    const beat = await s.control("heartbeat", app.ids);
    assert.equal(beat.registered, false);
    await app.register();
    assert.equal((await relay(port, s.origin, "GET", "/api/a")).status, 200);
    assert.equal((await s.control("heartbeat", app.ids)).registered, true);

    // A crashed launch: the socket refuses connections immediately.
    const next = await backend(s.record, s.control);
    await next.register();
    await close(next.server);
    assert.equal((await relay(port, s.origin, "GET", "/api/a")).status, 503);
    assert.equal((await s.hello()).backend.state, "none");
    await close(app.server);

    assert(alive(tunnel.pid));
    await s.control("shutdown");
    await new Promise((r) => s.child.once("exit", r));
    await until(() => !alive(tunnel.pid));
    assert(!existsSync(join(s.dir, "connection.json")));
    assert(!existsSync(s.record.control));
    assert(!existsSync(join(s.dir, "connection.lock")));
  } finally {
    await s.cleanup();
  }
});

test("failed re-registration stays detached until the socket proves itself again", async () => {
  const s = await service();
  const lease = new BackendLease(s.dir, s.record);
  lease.log = () => {};
  // Drive the production heartbeat deterministically after the relay withdraws
  // the socket, rather than racing the two-second interval between assertions.
  const beats = lease as unknown as {
    timer: NodeJS.Timeout;
    heartbeat(): Promise<void>;
  };
  let validProof = true;
  const app = createServer((req, res) => {
    const nonce = new URL(req.url!, "http://probe").searchParams.get("nonce");
    res.end(
      nonce
        ? JSON.stringify({ proof: validProof ? lease.probe(nonce) : "invalid" })
        : "ready",
    );
  });
  const listen = () => new Promise<void>((r) => app.listen(lease.socket, r));
  try {
    await lease.acquire();
    await listen();
    await lease.register();
    clearInterval(beats.timer);
    const {
      relay: { port },
    } = await s.hello();
    const generation = lease.generation;
    assert.equal(lease.attached, true);

    await close(app);
    assert.equal(
      (await relay(port, s.origin, "GET", "/api/check")).status,
      503,
    );
    validProof = false;
    await listen();
    for (let attempt = 0; attempt < 2; attempt++) {
      await beats.heartbeat();
      assert.equal((await s.hello()).backend.state, "none");
      assert.equal(
        (await relay(port, s.origin, "GET", "/api/check")).status,
        503,
      );
      assert.equal(
        lease.attached,
        false,
        "a rejected probe is not a registration",
      );
    }

    validProof = true;
    await beats.heartbeat();
    assert.equal(lease.attached, true);
    assert.equal((await s.hello()).backend.state, "ready");
    assert.equal(
      lease.generation,
      generation,
      "recovery keeps the existing lease",
    );
    assert.equal(
      (await relay(port, s.origin, "GET", "/api/check")).status,
      200,
    );
  } finally {
    await lease.withdraw();
    await close(app);
    await s.cleanup();
  }
});

for (const [speed, delay] of [
  ["fast", "0"],
  ["slow", "6000"],
])
  test(`a launch reattaches to a ${speed} replacement service and adopts its new address`, async () => {
    const first = await service();
    let second: Awaited<ReturnType<typeof service>> | undefined;
    const lease = new BackendLease(first.dir, first.record);
    const origins: string[] = [];
    lease.log = () => {};
    lease.onOrigin = (origin) => origins.push(origin);
    // The application's gateway: answers the probe, otherwise reports the Host it serves.
    const app = createServer((req, res) => {
      if (req.url?.startsWith("/__loop/backend-probe?")) {
        const nonce = new URL(req.url, "http://x").searchParams.get("nonce")!;
        res.end(JSON.stringify({ proof: lease.probe(nonce) }));
        return;
      }
      res.end(req.headers.host);
    });
    try {
      assert.equal(await lease.acquire(), first.origin);
      await new Promise<void>((r) => app.listen(lease.socket, r));
      await lease.register();
      assert.equal(
        (
          await relay(
            (await first.hello()).relay.port,
            first.origin,
            "GET",
            "/",
          )
        ).status,
        200,
      );

      // The service is replaced (unit or container restart). A slow
      // replacement answers on its control socket while its tunnel is still
      // starting, so heartbeats see it before it can grant a lease.
      await first.control("shutdown");
      await new Promise((r) => first.child.once("exit", r));
      second = await service({ LOOP_TEST_TUNNEL_DELAY_MS: delay }, first.dir);
      assert.notEqual(second.origin, first.origin);
      // The launch keeps retrying until the replacement grants it a lease.
      const end = Date.now() + 15000;
      while ((await second.hello()).backend.state !== "ready") {
        assert(
          Date.now() < end,
          "the launch never reattached to the replacement service",
        );
        await new Promise((r) => setTimeout(r, 200));
      }
      assert.equal(lease.origin, second.origin);
      assert.deepEqual(
        origins,
        [second.origin],
        "the gateway adopted the new address",
      );
      const res = await relay(
        (await second.hello()).relay.port,
        second.origin,
        "GET",
        "/",
      );
      assert.equal(res.status, 200);
      assert.equal(res.body.toString(), new URL(second.origin).host);
    } finally {
      await lease.withdraw();
      await close(app);
      await second?.cleanup();
      await first.cleanup();
    }
  });

test("a second service for the same directory refuses to start", async () => {
  const s = await service();
  try {
    const second = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/connection-daemon.ts",
        "--dir",
        s.dir,
        "--root",
        s.dir,
      ],
      {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: { ...process.env, LOOP_TEST_CLOUDFLARED: FAKE },
      },
    );
    const message: any = await new Promise((r) => second.once("message", r));
    assert.match(message.error, /starting or running/);
    await new Promise((r) => second.once("exit", r));
    assert.equal(
      readFileSync(s.tunnels, "utf8").trim().split("\n").length,
      1,
      "one cloudflared",
    );
    assert.equal((await s.hello()).instance, s.record.instance);
  } finally {
    await s.cleanup();
  }
});
