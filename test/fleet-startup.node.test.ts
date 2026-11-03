import test from "node:test";
import Database from "better-sqlite3";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  statSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";

async function startup(directory: string, extra: Record<string, string> = {}) {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
      const { db } = await import('./src/server/db.ts');
      let refused = false, lifecycle, http, workspaceServices = false, mailServices = false;
      if (process.env.LOOP55_TEST_FLEET_IDENTITY_ONLY === '1') {
        const { initializeFleetIdentity } = await import('./src/server/fleet-identity.ts');
        const { seal, unseal } = await import('./src/server/secrets.ts');
        initializeFleetIdentity(db, { seal, unseal });
      } else try {
        const { WorkspaceHost } = await import('./src/workspace-host.ts');
        const options = {
          harness: 'codex', executable: process.execPath,
          project: process.env.LOOP55_DATA_DIR, version: 'fixture', billing: 'existing',
          fleet: process.env.LOOP55_TEST_FLEET_OFF !== '1'
        };
        let mailBridge, bridgeInstalledBeforeOpen = false;
        const host = new WorkspaceHost(process.env.LOOP55_DATA_DIR, options,
          process.env.LOOP55_TEST_FLEET_WORKER === '1' ? {
            setFleetMail: service => { mailBridge = service; },
            open: async () => { bridgeInstalledBeforeOpen = !!mailBridge; },
            schedule: async () => {}, close: async () => {}
          } : undefined);
        workspaceServices = !!host.fleetWorkspace && !!host.gateway.workspace.sources && !!host.gateway.workspace.fleetCommandsHttp;
        mailServices = !!host.fleetMail;
        if (process.env.LOOP55_TEST_FLEET_HTTP === '1') {
          // Production gateway and routes, reached by a device paired here.
          const { request } = await import('node:http');
          const origin = 'https://workspace.example';
          await host.gateway.listen();
          host.setOrigin(origin);
          const call = (path, body, headers = {}) => new Promise((resolve, reject) => {
            const req = request({ hostname: '127.0.0.1', port: host.gateway.port, path,
              method: body === undefined ? 'GET' : 'POST',
              headers: { host: 'workspace.example', origin, 'content-type': 'application/json', ...headers } }, res => {
              const chunks = [];
              res.on('data', chunk => chunks.push(chunk));
              res.on('end', () => {
                const text = Buffer.concat(chunks).toString();
                let json; try { json = JSON.parse(text); } catch {}
                resolve({ status: res.statusCode, headers: res.headers, body: json });
              });
            });
            req.on('error', reject);
            req.end(body === undefined ? undefined : JSON.stringify(body));
          });
          const link = host.gateway.pair().url;
          const { fleetDeviceFromLink } = await import('./src/shared/fleet-pairing.ts');
          const device = link.includes('#pair=')
            ? { secret: new URL(link).hash.replace(/^#pair=/, '') }
            : fleetDeviceFromLink(link, origin);
          const paired = await call('/pair', { ...device, name: 'Fixture' });
          const cookie = paired.headers['set-cookie'][0].split(';')[0];
          const csrf = (await call('/session', undefined, { cookie })).body.csrf;
          const status = async (path, body) => (await call(path, body, { cookie, 'x-loop55-csrf': csrf })).status;
          const capabilities = (await call('/api/capabilities', undefined, { cookie })).body;
          http = {
            link: link.includes('#pair=') && !link.includes('fleet'),
            paired: paired.status,
            capabilities: Object.hasOwn(capabilities, 'fleet'),
            fleetRoutes: [
              await status('/api/fleet/admin/state'),
              await status('/api/fleet/commands/receipt', {}),
              await status('/api/fleet/peer/v1/credentials/challenge', {}),
            ],
            coreRoutes: [
              await status('/api/bootstrap'),
              await status('/api/feed?filter=queued'),
              await status('/api/scheduled-sends'),
            ],
            invalidSubmit: await status('/api/runs', {}),
          };
          await host.close();
        }
        if (process.env.LOOP55_TEST_FLEET_WORKER === '1') {
          if (!host.fleetDistribution || !host.fleetMail) throw new Error('Missing fleet workers');
          const { fleetMailDiscovery } = await import('./src/server/fleet-mail-tools.ts');
          const { OWNER } = await import('./src/server/native-sessions.ts');
          if (fleetMailDiscovery(OWNER)) throw new Error('Mail enabled before listening');
          // Stub unrelated Docker discovery; exercise the actual gateway start,
          // worker scheduler, empty outbox read and gateway shutdown.
          host.mcpSharing.start = () => {};
          let ticks = 0, mailTicks = 0;
          const flush = host.fleetDistribution.flush.bind(host.fleetDistribution);
          host.fleetDistribution.flush = async () => { ticks++; await flush(); };
          const drain = host.fleetMail.drainer.drain.bind(host.fleetMail.drainer);
          host.fleetMail.drainer.drain = async () => { mailTicks++; await drain(); };
          await host.start(options, undefined, undefined, true);
          const toolsEnabled = !!fleetMailDiscovery(OWNER);
          await new Promise(resolve => setTimeout(resolve, 1200));
          await host.close();
          const stoppedAt = ticks;
          const mailStoppedAt = mailTicks;
          await new Promise(resolve => setTimeout(resolve, 1200));
          lifecycle = {
            started: stoppedAt > 0, stopped: stoppedAt === ticks,
            mailStarted: mailStoppedAt > 0, mailStopped: mailStoppedAt === mailTicks,
            bridgeInstalledBeforeOpen, bridgeCleared: !mailBridge,
            toolsEnabled, toolsDisabled: !fleetMailDiscovery(OWNER)
          };
        }
      } catch (error) {
        if (process.env.LOOP55_PROFILE !== 'server') throw error;
        refused = /requires LOOP55_PROFILE=companion/.test(error.message);
        if (!refused) throw error;
      }
      console.log(JSON.stringify({
        refused,
        identities: db.prepare('SELECT machine_id,public_key FROM fleet_machine_identity').all(),
        integrity: db.pragma('integrity_check'),
        workers: db.prepare('SELECT count(*) n FROM fleet_distribution_instances').get().n,
        lifecycle,
        http,
        workspaceServices,
        mailServices,
      }));
      db.close();
      process.exit(0);
    `,
    ],
    {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !key.startsWith("LOOP55_"),
          ),
        ),
        LOOP55_DATA_DIR: directory,
        LOOP55_PROFILE: "companion",
        LOOP55_ENCRYPTION_KEY: "ab".repeat(32),
        LOOP55_PREVIEW_MANIFEST: "",
        BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
        GITHUB_CLIENT_ID: "",
        GITHUB_CLIENT_SECRET: "",
        NODE_ENV: "test",
        ...extra,
      },
    },
  );
  return JSON.parse(stdout);
}

test("companion gateway startup keeps machine identity across process and origin changes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "loop55-fleet-startup-"));
  try {
    const first = await startup(directory, { LOOP55_ENCRYPTION_KEY: "" });
    const encryptionKey = readFileSync(
      join(directory, "encryption-key"),
      "utf8",
    );
    assert.match(encryptionKey, /^[a-f0-9]{64}$/);
    assert.equal(
      statSync(join(directory, "encryption-key")).mode & 0o777,
      0o600,
    );
    assert.equal(first.identities.length, 1);
    assert.equal(first.workers, 1);
    assert.equal(first.workspaceServices, true);
    assert.equal(first.mailServices, true);
    assert.match(first.identities[0].machine_id, /^m_[a-f0-9]{64}$/);
    assert.deepEqual(
      await startup(directory, {
        LOOP55_URL: "https://rotated.example",
        LOOP55_ENCRYPTION_KEY: "",
      }),
      first,
    );
    assert.deepEqual(first.integrity, [{ integrity_check: "ok" }]);
    assert.equal(
      readFileSync(join(directory, "encryption-key"), "utf8"),
      encryptionKey,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("companion startup without --fleet creates no fleet identity or routes, keeps core routes, and --fleet mounts them", async () => {
  const directory = mkdtempSync(join(tmpdir(), "loop55-fleet-off-"));
  try {
    const result = await startup(directory, {
      LOOP55_TEST_FLEET_OFF: "1",
      LOOP55_TEST_FLEET_HTTP: "1",
    });
    assert.deepEqual(result.identities, []);
    assert.equal(result.workers, 0);
    assert.equal(result.workspaceServices, false);
    assert.equal(result.mailServices, false);
    assert.deepEqual(result.http, {
      // Core device pairing: a device-only link, redeemed by the gateway.
      link: true,
      paired: 200,
      capabilities: false,
      fleetRoutes: [404, 404, 404],
      coreRoutes: [200, 200, 200],
      // The submit route is mounted and validates its input.
      invalidSubmit: 400,
    });
    // The same routes exist when the host is started with --fleet.
    const on = await startup(mkdtempSync(join(tmpdir(), "loop55-fleet-on-")), {
      LOOP55_TEST_FLEET_HTTP: "1",
    });
    assert.equal(on.identities.length, 1);
    assert.equal(on.http.paired, 200);
    assert.equal(on.http.capabilities, false);
    for (const route of on.http.fleetRoutes) assert.notEqual(route, 404);
    assert.deepEqual(on.http.coreRoutes, [200, 200, 200]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("server profile and isolated preview startup never create fleet signing identities", async () => {
  const directory = mkdtempSync(join(tmpdir(), "loop55-fleet-profile-"));
  try {
    const server = await startup(join(directory, "server"), {
      LOOP55_PROFILE: "server",
    });
    assert.equal(server.refused, true);
    assert.equal(server.workers, 0);
    assert.equal(server.workspaceServices, false);
    assert.equal(server.mailServices, false);
    assert.deepEqual(server.identities, []);
    for (const mode of ["design", "working"]) {
      const home = join(directory, "preview-" + mode),
        data = join(home, "workspace");
      mkdirSync(data, { recursive: true });
      const manifest = {
        schema: 1,
        previewId: randomUUID(),
        name: "fleet-fixture",
        mode,
        home,
        build: {
          id: randomUUID(),
          branch: "fixture",
          commit: "a".repeat(40),
          dirty: false,
          builtAt: "fixture",
          sourceHash: "b".repeat(64),
          artifactHash: "c".repeat(64),
        },
      };
      const path = join(data, "preview-owner.json");
      writeFileSync(path, JSON.stringify(manifest));
      const isolated = await startup(data, {
        LOOP55_PREVIEW_MANIFEST: path,
        LOOP55_HOME: home,
        LOOP55_ENCRYPTION_KEY: "",
      });
      assert.deepEqual(isolated.identities, []);
      assert.equal(isolated.workspaceServices, false);
      assert.equal(isolated.mailServices, false);
      assert.equal(existsSync(join(data, "encryption-key")), false);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("companion gateway owns directory and mail workers across the runtime lifecycle", async () => {
  const directory = mkdtempSync(join(tmpdir(), "loop55-fleet-lifecycle-"));
  try {
    const result = await startup(directory, { LOOP55_TEST_FLEET_WORKER: "1" });
    assert.deepEqual(result.lifecycle, {
      started: true,
      stopped: true,
      mailStarted: true,
      mailStopped: true,
      bridgeInstalledBeforeOpen: true,
      bridgeCleared: true,
      toolsEnabled: true,
      toolsDisabled: true,
    });
    assert.equal(result.workers, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("concurrent processes initialize one key and do not revive unreadable signing material", async () => {
  const directory = mkdtempSync(join(tmpdir(), "loop55-fleet-concurrent-"));
  const options = {
    LOOP55_TEST_FLEET_IDENTITY_ONLY: "1",
    LOOP55_ENCRYPTION_KEY: "",
  };
  try {
    const attempts = await Promise.allSettled([
      startup(directory, options),
      startup(directory, options),
    ]);
    for (const result of attempts)
      if (result.status === "rejected") throw result.reason;
    assert.equal(attempts[0].status, "fulfilled");
    assert.equal(attempts[1].status, "fulfilled");
    if (
      attempts[0].status !== "fulfilled" ||
      attempts[1].status !== "fulfilled"
    )
      return;
    assert.equal(attempts[0].value.identities.length, 1);
    assert.deepEqual(attempts[0].value, attempts[1].value);
    await assert.rejects(
      startup(directory, {
        ...options,
        LOOP55_ENCRYPTION_KEY: "cd".repeat(32),
      }),
    );
    const database = new Database(join(directory, "loop55.db"));
    const original = database
      .prepare("SELECT private_key FROM fleet_machine_identity")
      .get() as { private_key: string };
    const parts = original.private_key.split(".");
    parts[1] = (parts[1][0] === "0" ? "1" : "0") + parts[1].slice(1);
    database
      .prepare("UPDATE fleet_machine_identity SET private_key=?")
      .run(parts.join("."));
    await assert.rejects(startup(directory, options));
    assert.equal(
      (
        database
          .prepare("SELECT private_key FROM fleet_machine_identity")
          .get() as { private_key: string }
      ).private_key,
      parts.join("."),
    );
    database
      .prepare("UPDATE fleet_machine_identity SET private_key=?")
      .run(original.private_key);
    database.close();
    assert.deepEqual(await startup(directory, options), attempts[0].value);
    // Removing the encryption key cannot silently mint a new machine identity.
    const keyPath = join(directory, "encryption-key");
    const key = readFileSync(keyPath, "utf8");
    rmSync(keyPath);
    await assert.rejects(startup(directory, options));
    writeFileSync(keyPath, key, { mode: 0o600 });
    assert.deepEqual(await startup(directory, options), attempts[0].value);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
