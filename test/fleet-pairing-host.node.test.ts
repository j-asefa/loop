import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { request } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import Database from "better-sqlite3";
import { z } from "zod";
import { applyMigrations } from "../src/server/migrations.js";
import { FleetAuthority } from "../src/server/fleet-authority.js";
import { FleetPairing } from "../src/server/fleet-pairing.js";
import {
  fleetDeviceFromLink,
  fleetEnrollmentFromLink,
} from "../src/shared/fleet-pairing.js";
import { Host } from "../src/host.js";
import { control } from "../src/host-control.js";

test("the HTTP gateway uses atomic companion pairing without exchanging an enrollment capability for a device cookie", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "loop-fleet-pair-http-"));
  process.env.LOOP_DATA_DIR = dir;
  process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  const secrets = await import("../src/server/secrets.js");
  const db = new Database(join(dir, "workspace.db"));
  applyMigrations(db);
  db.prepare("INSERT INTO deployment_profile VALUES(1,'companion')").run();
  const authority = new FleetAuthority(db, secrets),
    owner = "local-destination-owner";
  const origin = "https://destination.example";
  let now = Date.now();
  t.mock.timers.enable({ apis: ["setInterval"] });
  const initial = {
    harness: "codex" as const,
    version: "fixture",
    project: dir,
    billing: { mode: "existing" as const, description: "Fixture" },
    capabilities: {
      approvals: true,
      questions: true,
      resume: true,
      liveAttach: false,
      terminal: false,
    },
  };
  let host: Host | undefined;
  const launch = async () => {
    const pairing = new FleetPairing(db, authority, owner, dir, () => now);
    host = new Host(dir, initial, pairing);
    await host.listen();
    host.setOrigin(origin);
    return pairing;
  };
  const send = (
    path: string,
    input?: unknown,
    headers: Record<string, string> = {},
  ) =>
    new Promise<{
      status: number;
      headers: import("node:http").IncomingHttpHeaders;
      body: any;
    }>((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port: host!.port,
          path,
          method: input ? "POST" : "GET",
          headers: {
            host: new URL(origin).host,
            origin,
            ...(input ? { "content-type": "application/json" } : {}),
            ...headers,
          },
        },
        (res) => {
          let text = "";
          res.on("data", (chunk) => (text += chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode!,
              headers: res.headers,
              body: JSON.parse(text),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(input ? JSON.stringify(input) : undefined);
    });
  try {
    let pairing = await launch();
    const link = host!.pair(),
      device = fleetDeviceFromLink(link.url, origin),
      enrollment = fleetEnrollmentFromLink(link.url);
    const denied = await send("/pair", {
      secret: enrollment.enrollment,
      name: "Peer",
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers["set-cookie"], undefined);
    assert.equal(
      (
        await send(
          "/pair",
          { ...device, name: "Phone" },
          { origin: "https://wrong.example" },
        )
      ).status,
      403,
    );
    const results = await Promise.all([
      send("/pair", { ...device, name: "Phone" }),
      send("/pair", { ...device, name: "Phone" }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 403]);
    const success = results.find((r) => r.status === 200)!;
    assert.deepEqual(success.body, { paired: true });
    const setCookie = success.headers["set-cookie"]![0],
      cookie = setCookie.split(";")[0];
    assert.match(setCookie, /HttpOnly; Secure; SameSite=Lax/);
    assert(!setCookie.includes(device.secret));
    assert(!setCookie.includes(enrollment.enrollment));
    const session = await send("/session", undefined, { cookie });
    assert.equal(session.status, 200);
    assert.deepEqual(Object.keys(session.body.device).sort(), [
      "expires",
      "id",
      "name",
    ]);
    assert.throws(() =>
      pairing.consumeEnrollment(
        {
          ceremonyId: enrollment.ceremonyId,
          secret: enrollment.enrollment,
          origin,
          operationId: randomUUID(),
          request: { confirmed: true },
        },
        z.object({ ok: z.boolean() }),
        () => ({ ok: true }),
      ),
    );
    await host!.close();
    host = undefined;
    pairing = await launch();
    assert.equal((await send("/session", undefined, { cookie })).status, 200);
    const enrollmentOnly = fleetEnrollmentFromLink(
      pairing.enrollment(origin).url,
    );
    pairing.consumeEnrollment(
      {
        ceremonyId: enrollmentOnly.ceremonyId,
        secret: enrollmentOnly.enrollment,
        origin,
        operationId: randomUUID(),
        request: { confirmed: true },
      },
      z.object({ ok: z.boolean() }),
      () => ({ ok: true }),
    );
    assert.equal(
      (
        await send("/pair", {
          secret: enrollmentOnly.enrollment,
          name: "Not a device",
        })
      ).status,
      403,
    );
    assert.equal((await send("/session", undefined, { cookie })).status, 200);
    assert.equal(pairing.devices().length, 1);
    const beforeRollback = now;
    now -= 1000;
    // Local administration must not depend on authentication eligibility.
    assert.equal((await send("/session", undefined, { cookie })).status, 401);
    assert.deepEqual(
      (await control(dir, "devices")).map(
        (device: { id: string }) => device.id,
      ),
      [session.body.device.id],
    );
    await control(dir, "revoke", { id: session.body.device.id });
    assert.equal(
      (
        db.prepare("SELECT count(*) n FROM fleet_devices").get() as {
          n: number;
        }
      ).n,
      0,
    );
    now = beforeRollback;
    assert.equal((await send("/session", undefined, { cookie })).status, 401);
    await host!.close();
    host = undefined;
    await launch();
    assert.equal((await send("/session", undefined, { cookie })).status, 401);
    for (const blocked of [false, true]) {
      const fresh = fleetDeviceFromLink(host!.pair().url, origin);
      const response = await send("/pair", {
        ...fresh,
        name: "Expiring phone",
      });
      const expiredCookie = response.headers["set-cookie"]![0].split(";")[0];
      const expires = now + 1000;
      db.prepare("UPDATE fleet_devices SET expires=?,max_expires=?").run(
        expires,
        expires,
      );
      const writer = blocked
        ? new Database(join(dir, "workspace.db"))
        : undefined;
      writer?.exec("BEGIN IMMEDIATE");
      try {
        now = expires + 1;
        t.mock.timers.tick(30000);
      } finally {
        writer?.exec("ROLLBACK");
        writer?.close();
      }
      await host!.close();
      host = undefined;
      now = expires - 500;
      pairing = await launch();
      assert.equal(
        (await send("/session", undefined, { cookie: expiredCookie })).status,
        401,
        "a heartbeat-observed expiry remains revoked after restart and clock rollback, including during a database writer lock",
      );
      now = expires + 1;
    }
    const fresh = fleetDeviceFromLink(host!.pair().url, origin);
    const response = await send("/pair", { ...fresh, name: "Crossing expiry" });
    const crossingCookie = response.headers["set-cookie"]![0].split(";")[0];
    const expires = now + 1000;
    db.prepare("UPDATE fleet_devices SET expires=?,max_expires=?").run(
      expires,
      expires,
    );
    const socket = new WebSocket(`ws://127.0.0.1:${host!.port}/ws`, {
      headers: { host: new URL(origin).host, origin, cookie: crossingCookie },
    });
    try {
      await once(socket, "open");
      let cross = true;
      const device = pairing.device.bind(pairing);
      t.mock.method(pairing, "device", (id: string) => {
        const result = device(id);
        if (cross) {
          // Time crosses expiry immediately after the real durable check.
          // Any later Host expiry decision would bypass that guard.
          cross = false;
          now = expires + 1;
        }
        return result;
      });
      t.mock.method(Date, "now", () => now);
      now = expires - 1;
      t.mock.timers.tick(30000);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(
        socket.readyState,
        WebSocket.OPEN,
        "the gateway must honor the guarded eligibility decision without making another undurable clock decision",
      );
      const closed = once(socket, "close");
      t.mock.timers.tick(30000);
      assert.equal((await closed)[0], 4003);
      await host!.close();
      host = undefined;
      now = expires - 500;
      pairing = await launch();
      assert.equal(
        (await send("/session", undefined, { cookie: crossingCookie })).status,
        401,
        "the next guarded expiry remains retired through restart and rollback",
      );
    } finally {
      socket.terminate();
    }
    assert.throws(
      () => new Host(dir, initial),
      /Device trust store is unreadable/,
    );
  } finally {
    await host?.close();
    t.mock.timers.reset();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
