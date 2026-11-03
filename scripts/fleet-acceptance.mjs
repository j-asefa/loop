import "../runtime/environment.mjs";
import { retainedPath } from "../runtime/name-upgrade.ts";
// Explicit, test-owned acceptance journey. Never invoked by test/check/CI.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createServer as createPortReservation } from "node:net";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import Database from "better-sqlite3";
import { testEnvironment } from "./test-runner.mjs";
import { acceptancePrompt } from "../test/fixtures/fleet-acceptance-client.mjs";
import { isWebKitNavigationFetchError } from "./helpers/browser-errors.mjs";
import {
  fixtureMeasurements,
  installedTunnelMeasurements,
  isolateAcceptanceEnvironment,
  safeFailure,
  stopAcceptanceCompanion,
  writeAcceptanceFile,
} from "./helpers/fleet-acceptance-observations.mjs";

const { values } = parseArgs({
  options: {
    help: { type: "boolean", short: "h" },
    fixtures: { type: "boolean" },
    "quick-tunnels": { type: "boolean" },
    package: { type: "string" },
    "upgrade-from": { type: "string" },
    output: { type: "string" },
  },
});
if (values.help || (!values.fixtures && !values["quick-tunnels"])) {
  console.log(`Fleet acceptance (run from a source checkout with installed dependencies)
  node scripts/fleet-acceptance.mjs --fixtures --output /tmp/fleet-fixtures.json
  node scripts/fleet-acceptance.mjs --quick-tunnels --output /tmp/fleet-transport.json
  --package /absolute/path/loop55.tgz  Test an existing package in tunnel mode.
  --upgrade-from /absolute/path/older-loop55.tgz  Start A on an older fleet package,
      verify unavailable peer features, then upgrade its existing workspace in place.
      Both packages must use Loop55 headers; see docs/name-upgrade.md.

Fixture mode runs focused boundary/native/browser checks and the package smoke.
Tunnel mode installs a package and starts THREE ISOLATED TEST companions behind
real Quick Tunnels. It uses a deterministic Codex fixture, no provider account,
and includes an eleven-minute interval without browser HTTP or WebSockets.
It does not establish separate-host, physical-phone or live-provider acceptance.
No mode is part of default tests or CI. See docs/fleet-acceptance.md.`);
  process.exit(0);
}
assert(values.fixtures !== values["quick-tunnels"], "Choose exactly one mode");
assert(
  (!values.package && !values["upgrade-from"]) || values["quick-tunnels"],
  "Package options require --quick-tunnels",
);

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execute = promisify(execFile);
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => abort.abort(new Error("Acceptance interrupted")));
const mode = values.fixtures ? "fixtures" : "quick-tunnels";
const planned = values.fixtures
  ? [
      "check",
      "build",
      "boundary-fixtures",
      "native-fixtures",
      "capacity-and-multiplex-measurements",
      "source-feed-chromium",
      "source-feed-webkit",
      "chromium",
      "webkit",
      "package",
    ]
  : [
      "package-install",
      ...(values["upgrade-from"] ? ["older-package-install"] : []),
      "launch-a",
      "launch-b",
      "launch-c",
      "unauthenticated-workspace-refused",
      "enroll-three-machines",
      ...(values["upgrade-from"] ? ["older-source-workspace-upgrade"] : []),
      "source-owned-agents-and-reads",
      "three-node-browser-feed-and-traffic",
      "authenticated-websocket-both-directions",
      "remote-command-and-duplicate-receipt",
      "mail-and-authorized-file",
      "gateway-loss-after-destination-acceptance",
      "mail-with-browser-closed-beyond-credential-lifetime",
      "all-addresses-change-with-controller-key-surviving",
      "signed-controller-handoff",
      "unavailable-controller-per-member-recovery",
    ];
const base = await mkdtemp(join(tmpdir(), "loop55-fleet-acceptance-"));
await chmod(base, 0o700);
const output = resolve(
  values.output ?? join(tmpdir(), `fleet-${mode}-${Date.now()}.json`),
);
await mkdir(dirname(output), { recursive: true });
const report = {
  version: 1,
  mode,
  startedAt: new Date().toISOString(),
  source: null,
  build: null,
  cases: [],
  limitations: [
    "Synthetic harnesses do not establish real provider behavior.",
    "Three data directories on one host do not establish separate-host acceptance.",
    "HTTP/WS clients do not establish physical-phone or mobile-browser acceptance.",
    "Client counts and sampled cloudflared metrics do not establish a capacity limit, socket classification or battery use.",
  ],
  pendingLiveCases: [
    "Second host/VM, physical iPhone or Android, and authenticated harnesses on two machines (one outside Claude/Codex).",
    "Physical-browser gateway-loss receipt recovery (the automated response-drop relay is a transport fixture).",
    "Mixed-version package upgrade and migration of an existing test workspace.",
    "Measured larger live fleet, concurrent peer/browser pressure and aggregate inbound tunnel headroom (fixture pressure and small-workload daemon samples are separate evidence).",
  ],
};
// Preserve CA/proxy configuration needed by the environment, but do not inherit
// Loop55 state, provider keys, tool tokens or selected live credentials.
let cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    [
      "PATH",
      "HOME",
      "USER",
      "LOGNAME",
      "SHELL",
      "TMPDIR",
      "TEMP",
      "TMP",
      "LANG",
      "LC_ALL",
      "TZ",
      "NODE_EXTRA_CA_CERTS",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
      "https_proxy",
      "http_proxy",
      "all_proxy",
      "no_proxy",
    ].includes(key),
  ),
);
if (values["quick-tunnels"])
  cleanEnv = await isolateAcceptanceEnvironment(cleanEnv, base);
const machines = [];
let bin;
const machineBin = (machine) => machine.bin ?? bin;
async function packageBuild(packageRoot) {
  const { publicBuild } = await import(
    pathToFileURL(join(packageRoot, "dist/shared/build.js"))
  );
  const { observedBuild } = await import(
    pathToFileURL(join(packageRoot, "dist/server/build-runtime.js"))
  );
  return publicBuild(observedBuild());
}
async function command(label, executable, args, options = {}) {
  const { ignoreAbort = false, fixtureLog, ...rest } = options;
  try {
    const result = await execute(executable, args, {
      cwd: root,
      env: cleanEnv,
      timeout: 300_000,
      maxBuffer: 16_000_000,
      ...(ignoreAbort ? {} : { signal: abort.signal }),
      ...rest,
    });
    if (fixtureLog)
      await writeAcceptanceFile(fixtureLog, result.stdout + result.stderr);
    return result;
  } catch (error) {
    if (fixtureLog)
      await writeAcceptanceFile(
        fixtureLog,
        (error.stdout ?? "") + (error.stderr ?? ""),
      );
    // execFile errors include captured CLI output, which may contain a pairing
    // capability. Never print, persist or rethrow that error object.
    throw Object.assign(new Error(`${label} failed`), {
      exit: Number.isInteger(error.code) ? error.code : null,
    });
  }
}
async function step(id, action) {
  assert(
    planned.includes(id),
    "Acceptance case must be listed in its report plan",
  );
  const start = Date.now();
  console.log(`fleet acceptance: ${id}`);
  try {
    const evidence = await action();
    report.cases.push({
      id,
      state: "passed",
      ms: Date.now() - start,
      evidence: evidence ?? null,
    });
  } catch (error) {
    report.cases.push({
      id,
      state: "failed",
      ms: Date.now() - start,
      exit: error.exit ?? null,
      failure: safeFailure(error),
    });
    throw new Error(id + " failed; private command output was withheld");
  }
}
async function eventually(label, action, timeout = 120_000) {
  const until = Date.now() + timeout;
  do {
    abort.signal.throwIfAborted();
    const result = await action();
    if (result) return result;
    await delay(1000, undefined, { signal: abort.signal });
  } while (Date.now() < until);
  throw Object.assign(new Error(label + " timed out"), {
    name: "TimeoutError",
  });
}
async function readAudit(machine) {
  try {
    return (await readFile(machine.audit, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
const scope = ["read", "act", "files", "mail", "events"];
const sourcePath = (machine, path) =>
  `/agent-sources/${encodeURIComponent("peer:" + machine.identity.machineId)}${path}`;

async function launch(machine) {
  machine.measureTunnel = await installedTunnelMeasurements(
    machine.packageRoot,
  );
  // Allocate only this test daemon's documented metrics listener. Never inspect
  // the default ports, which may belong to unrelated jobs on a shared host.
  const reservation = createPortReservation();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  machine.metricsPort = reservation.address().port;
  machine.env.TUNNEL_METRICS = "127.0.0.1:" + machine.metricsPort;
  await new Promise((resolve) => reservation.close(resolve));
  await command(
    "start isolated companion",
    machineBin(machine),
    [
      "codex",
      "--executable",
      machine.fixture,
      "--project",
      machine.project,
      "--billing",
      "existing",
      "--providers",
      "codex",
      "--fleet",
    ],
    { env: machine.env },
  );
  await pair(machine);
}
async function pair(machine) {
  let phase = "pair-link";
  try {
    const pairingLink = async () => {
      const { stdout } = await command(
        "pair isolated companion",
        machineBin(machine),
        ["pair"],
        { env: machine.env },
      );
      const link = stdout.match(
        /https:\/\/[a-z0-9-]+\.trycloudflare\.com\/#fleet=[A-Za-z0-9_-]+/,
      )?.[0];
      assert(link, "Expected a real Quick Tunnel fleet link");
      return link;
    };
    let link = await pairingLink();
    const origin = new URL(link).origin;
    phase = "pair-readiness";
    let lastError, lastStatus, readySince;
    // Fresh tunnel DNS can alternate between reachable and absent records.
    // Require 30 seconds of successful reads on fresh connections before the
    // one-time pairing submission; never replay an uncertain POST.
    try {
      await eventually("fresh tunnel readiness", async () => {
        const ready = await fetch(origin + "/api/bootstrap", {
          redirect: "error",
          headers: { Connection: "close" },
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5_000)]),
        }).catch((error) => {
          lastError = error;
          return null;
        });
        if (!ready) {
          readySince = undefined;
          return false;
        }
        lastStatus = ready.status;
        await ready.body?.cancel();
        assert.notEqual(
          ready.status,
          200,
          "An unpaired workspace must refuse access",
        );
        if (ready.status !== 401 && ready.status !== 403) {
          readySince = undefined;
          return false;
        }
        readySince ??= Date.now();
        return Date.now() - readySince >= 30_000;
      });
    } catch (error) {
      error.cause = lastError?.cause ?? lastError;
      error.status = lastStatus;
      throw error;
    }
    // Readiness may outlast a capability's lifetime. Mint once more only after
    // the read succeeds; the unused first capability is never submitted.
    phase = "pair-link";
    link = await pairingLink();
    assert.equal(new URL(link).origin, origin);
    phase = "pair-submit";
    const response = await fetch(origin + "/pair", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({
        ...machine.links.fleetDeviceFromLink(link, origin),
        name: "Fleet acceptance fixture",
      }),
    });
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    assert(cookie);
    assert.deepEqual(await response.json(), { paired: true });
    phase = "pair-session";
    const session = await fetch(origin + "/session", {
      redirect: "error",
      headers: { Cookie: cookie },
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(session.status, 200);
    const { csrf } = await session.json();
    assert.equal(typeof csrf, "string");
    machine.origin = origin;
    machine.cookie = cookie;
    machine.csrf = csrf;
    machine.api = async (path, body, options = {}) => {
      const start = Date.now();
      const request = await fetch(origin + "/api" + path, {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(60_000)]),
        headers: {
          Cookie: cookie,
          Origin: origin,
          "x-loop55-csrf": csrf,
          "Content-Type": "application/json",
          ...options.headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await request.text();
      machine.metrics.requests++;
      machine.metrics.bytes += Buffer.byteLength(text);
      machine.metrics.maxMs = Math.max(
        machine.metrics.maxMs,
        Date.now() - start,
      );
      if (options.status) assert.equal(request.status, options.status);
      else if (!request.ok)
        throw Object.assign(new Error("Test workspace request was refused"), {
          status: request.status,
        });
      return text ? JSON.parse(text) : null;
    };
    phase = "pair-state";
    const state = await machine.api("/fleet/admin/state");
    if (machine.identity) assert.deepEqual(state.identity, machine.identity);
    machine.identity = state.identity;
  } catch (error) {
    error.phase = phase;
    throw error;
  }
}
async function enroll(controller, destination, mode = "enroll") {
  const { url } = await destination.api("/fleet/admin/enrollment-link", {
    scope,
    recover: mode === "recover",
    confirm: true,
  });
  const { head } = await controller.api("/fleet/admin/state");
  const operationId = randomUUID();
  let job = await controller.api("/fleet/admin/enrollment/begin", {
    operationId,
    expected: head,
    link: destination.links.fleetEnrollmentFromLink(url),
    name: "Fixture " + destination.name,
    mode,
    scope,
    confirm: true,
  });
  await eventually("enrollment", async () => {
    if (job.state === "complete") return true;
    assert.notEqual(job.state, "cancelled");
    const action = ["ready", "prepared"].includes(job.state)
      ? "advance"
      : "reconcile";
    job = await controller.api("/fleet/admin/enrollment/" + action, {
      operationId,
    });
    return job.state === "complete";
  });
}
async function synchronized(controller) {
  await eventually("signed directory acknowledgement", async () => {
    const state = await controller.api("/fleet/admin/state");
    if (state.pendingDistribution) return false;
    for (const machine of machines) {
      const peer = await machine.api("/fleet/admin/state");
      if (peer.head !== state.head) return false;
    }
    return true;
  });
}
async function socketProbe(gateway) {
  const { WorkspaceMuxResponse } = await import(
    pathToFileURL(
      join(gateway.packageRoot, "dist/shared/workspace-multiplex.js"),
    )
  );
  const sources = machines.map((machine) =>
    machine === gateway ? "" : "peer:" + machine.identity.machineId,
  );
  const seen = new Set();
  let frames = 0,
    bytes = 0;
  await new Promise((accept, reject) => {
    const socket = new WebSocket(
      gateway.origin.replace("https:", "wss:") + "/api/events/multiplex/ws",
      {
        headers: { Cookie: gateway.cookie, Origin: gateway.origin },
        handshakeTimeout: 30_000,
      },
    );
    const timeout = setTimeout(
      () => finish(new Error("Multiplex transport timed out")),
      60_000,
    );
    const finish = (error) => {
      clearTimeout(timeout);
      socket.terminate();
      if (error) reject(error);
      else accept();
    };
    socket.on("error", finish);
    socket.on("open", () =>
      sources.forEach((source) =>
        socket.send(
          JSON.stringify({
            v: 1,
            type: "subscribe",
            id: randomUUID(),
            source,
            epoch: "",
            cursor: 0,
            conversations: [],
            runs: [],
          }),
        ),
      ),
    );
    socket.on("message", (data) => {
      try {
        frames++;
        bytes += data.length;
        const packet = WorkspaceMuxResponse.parse(JSON.parse(data.toString()));
        assert.equal(packet.type, "frame");
        assert(sources.includes(packet.source));
        seen.add(packet.source);
        if (seen.size === sources.length) finish();
      } catch {
        finish(new Error("Invalid or unavailable source frame"));
      }
    });
  });
  return { sources: seen.size, browserSockets: 1, frames, bytes };
}
async function sendCase(from, recipient, caseId, options = {}) {
  const body = {
    agentId: from.sender.id,
    input: acceptancePrompt({
      caseId,
      kind: "send",
      to: `peer:${recipient.identity.machineId}:${recipient.agent.id}`,
      replyTo: `peer:${from.identity.machineId}:${from.sender.id}`,
      ...options,
    }),
    idempotencyKey: randomUUID(),
  };
  return from.api("/runs", body);
}
async function confirmMail(sender, recipient, caseId, file = false) {
  return eventually("mail reply", async () => {
    const rows = [
      ...(await readAudit(sender)),
      ...(await readAudit(recipient)),
    ].filter((row) => row.caseId === caseId);
    assert(!rows.some((row) => !row.ok), "Native acceptance task failed");
    if (!rows.some((row) => row.kind === "ack")) return false;
    assert.equal(rows.filter((row) => row.kind === "send").length, 1);
    assert.equal(rows.filter((row) => row.kind === "receive").length, 1);
    assert.equal(rows.filter((row) => row.kind === "ack").length, 1);
    if (file) assert(rows.find((row) => row.kind === "receive").fileVerified);
    return { sent: 1, received: 1, replies: 1, attachmentRead: file };
  });
}

function durableCounts(machine, commandId) {
  const database = new Database(
    retainedPath(
      join(machine.env.LOOP55_HOME, "workspace"),
      "loop55.db",
      "loop.db",
    ),
    { readonly: true, fileMustExist: true },
  );
  try {
    const commands = database
      .prepare("SELECT state FROM fleet_command_receipts WHERE command_id=?")
      .all(commandId);
    const runs = database
      .prepare("SELECT id,state FROM runs WHERE idempotency_key=?")
      .all(commandId);
    return { commands, runs };
  } finally {
    database.close();
  }
}

async function gatewayLoss(gateway, destination, alternate) {
  const commandId = randomUUID(),
    caseId = "gateway-loss-effect";
  const body = {
    agentId: destination.agent.id,
    input: acceptancePrompt({ caseId, kind: "ack" }),
    idempotencyKey: commandId,
  };
  const { fleetActionInput } = await import(
    pathToFileURL(
      join(gateway.packageRoot, "dist/shared/fleet-action-input.js"),
    )
  );
  const { fleetPayloadDigest } = await import(
    pathToFileURL(join(gateway.packageRoot, "dist/server/fleet-crypto.js"))
  );
  const reference = {
    peer: destination.identity.machineId,
    commandId,
    route: "submit",
    payloadDigest: fleetPayloadDigest(
      fleetActionInput({ route: "submit", params: {}, body }, commandId),
    ),
  };
  let accepted, refused, held;
  const committed = new Promise((resolve, reject) => {
    accepted = resolve;
    refused = reject;
  });
  let timeout, client;
  // A loopback response-drop relay stands in for the browser connection. Its
  // fixed request goes through the real HTTPS gateway and destination. It
  // withholds the entire browser response until after the gateway is stopped.
  // This requires no production fault endpoint or access to process secrets.
  let claimed = false;
  const relay = createServer((request, response) => {
    request.resume();
    if (claimed || request.method !== "POST" || request.url !== "/submit") {
      response.writeHead(404).end();
      return;
    }
    claimed = true;
    held = response;
    void gateway
      .api(sourcePath(destination, "/runs"), body, {
        headers: { "x-loop55-command-id": commandId },
      })
      .then(accepted, () => refused(new Error("Gateway dispatch failed")));
  });
  try {
    await new Promise((resolve, reject) => {
      relay.once("error", reject);
      relay.listen(0, "127.0.0.1", resolve);
    });
    timeout = setTimeout(
      () => refused(new Error("Gateway acceptance timed out")),
      90_000,
    );
    client = fetch(`http://127.0.0.1:${relay.address().port}/submit`, {
      method: "POST",
      signal: AbortSignal.timeout(120_000),
    }).then(
      () => true,
      () => false,
    );
    const run = await committed;
    clearTimeout(timeout);
    const before = durableCounts(destination, commandId);
    assert.deepEqual(before.commands, [{ state: "completed" }]);
    assert.equal(before.runs.length, 1);
    assert.equal(before.runs[0].id, run.id);
    await command(
      "stop test gateway after acceptance",
      machineBin(gateway),
      ["stop"],
      {
        env: gateway.env,
      },
    );
    held.destroy();
    assert.equal(
      await client,
      false,
      "The browser stand-in must not receive success",
    );
    // C queries B while A and its controller process are unavailable. No new
    // action ID or original body is submitted to obtain this outcome.
    const receipt = await alternate.api("/fleet/commands/receipt", reference);
    assert.equal(receipt.state, "completed");
    assert.equal(receipt.result.id, run.id);
    const same = await alternate.api(sourcePath(destination, "/runs"), body, {
      headers: { "x-loop55-command-id": commandId },
    });
    assert.equal(same.id, run.id);
    await alternate.api(
      sourcePath(destination, "/runs"),
      {
        ...body,
        input: "Changed acceptance payload must be refused",
      },
      { headers: { "x-loop55-command-id": commandId }, status: 409 },
    );
    const absentCommandId = randomUUID(),
      absentCaseId = "gateway-absent-effect";
    const absentBody = {
      ...body,
      input: acceptancePrompt({ caseId: absentCaseId, kind: "ack" }),
      idempotencyKey: absentCommandId,
    };
    const missing = await alternate.api("/fleet/commands/receipt", {
      ...reference,
      commandId: absentCommandId,
      payloadDigest: fleetPayloadDigest(
        fleetActionInput(
          { route: "submit", params: {}, body: absentBody },
          absentCommandId,
        ),
      ),
    });
    assert.equal(missing.state, "refused");
    assert.deepEqual(durableCounts(destination, absentCommandId), {
      commands: [{ state: "refused" }],
      runs: [],
    });
    await alternate.api(sourcePath(destination, "/runs"), absentBody, {
      headers: { "x-loop55-command-id": absentCommandId },
      status: 409,
    });
    await eventually("single native effect", async () => {
      const effects = (await readAudit(destination)).filter(
        (row) => row.caseId === caseId,
      );
      if (!effects.length) return false;
      assert.equal(effects.length, 1);
      assert.equal(effects[0].ok, true);
      return (
        durableCounts(destination, commandId).runs[0].state === "completed"
      );
    });
    const after = durableCounts(destination, commandId);
    assert.equal(after.commands.length, 1);
    assert.equal(after.runs.length, 1);
    await launch(gateway);
    const state = await gateway.api("/fleet/admin/state");
    await gateway.api("/fleet/admin/repair-self", {
      mutationId: randomUUID(),
      expected: state.head,
      confirm: true,
    });
    await synchronized(gateway);
    assert.equal(
      (await readAudit(destination)).filter((row) => row.caseId === caseId)
        .length,
      1,
    );
    assert.deepEqual(durableCounts(destination, absentCommandId), {
      commands: [{ state: "refused" }],
      runs: [],
    });
    assert.equal(
      (await readAudit(destination)).filter(
        (row) => row.caseId === absentCaseId,
      ).length,
      0,
    );
    return {
      responseDropped: true,
      relayFixture: true,
      gatewayStopped: true,
      alternateReceipt: "completed",
      absentReceipt: "refused",
      lateAbsentDispatchRefused: true,
      absentCommandRows: 1,
      absentRunRows: 0,
      absentNativeEffects: 0,
      commandRows: 1,
      runRows: 1,
      nativeEffects: 1,
    };
  } finally {
    clearTimeout(timeout);
    held?.destroy();
    relay.closeAllConnections();
    await new Promise((resolve) => relay.close(resolve));
    await client;
  }
}

async function tunnelSnapshot() {
  return Promise.all(
    machines.map(async (machine) => {
      try {
        const response = await fetch(
          `http://127.0.0.1:${machine.metricsPort}/metrics`,
          {
            redirect: "error",
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(2_000)]),
          },
        );
        if (!response.ok)
          return {
            machine: machine.name,
            state: "unavailable",
            status: response.status,
          };
        const text = await response.text();
        assert(text.length <= 1_000_000);
        return {
          machine: machine.name,
          ...machine.measureTunnel(text),
        };
      } catch {
        return {
          machine: machine.name,
          state: "unavailable",
          reason: "metrics-request-failed",
        };
      }
    }),
  );
}
async function browserMeasurements(gateway, destination) {
  const engines = await import("@playwright/test");
  const measurements = [];
  for (const engine of ["chromium", "webkit"]) {
    const browser = await engines[engine].launch({ headless: true });
    try {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2,
        serviceWorkers: "block",
      });
      const separator = gateway.cookie.indexOf("=");
      await context.addCookies([
        {
          url: gateway.origin,
          name: gateway.cookie.slice(0, separator),
          value: gateway.cookie.slice(separator + 1),
          secure: true,
          httpOnly: true,
        },
      ]);
      const page = await context.newPage();
      const open = new Set(),
        sizes = new Set();
      const metrics = {
        requests: 0,
        responseBytes: 0,
        unmeasuredResponses: 0,
        failedRequests: 0,
        frames: 0,
        frameBytes: 0,
        maxEventSockets: 0,
      };
      let errors = 0;
      page.on("pageerror", (error) => {
        if (!isWebKitNavigationFetchError(engine, error, gateway.origin))
          errors++;
      });
      page.on("request", () => metrics.requests++);
      page.on("requestfailed", () => metrics.failedRequests++);
      page.on("requestfinished", (request) => {
        const pending = request
          .sizes()
          .then((size) => {
            metrics.responseBytes +=
              size.responseBodySize + size.responseHeadersSize;
          })
          .catch(() => metrics.unmeasuredResponses++)
          .finally(() => sizes.delete(pending));
        sizes.add(pending);
      });
      page.on("websocket", (socket) => {
        if (new URL(socket.url()).pathname !== "/api/events/multiplex/ws")
          return;
        open.add(socket);
        metrics.maxEventSockets = Math.max(metrics.maxEventSockets, open.size);
        socket.on("close", () => open.delete(socket));
        const frame = ({ payload }) => {
          metrics.frames++;
          metrics.frameBytes +=
            typeof payload === "string"
              ? Buffer.byteLength(payload)
              : payload.length;
        };
        socket.on("framesent", frame);
        socket.on("framereceived", frame);
      });
      const tunnelBefore = await tunnelSnapshot();
      const start = performance.now();
      await page.goto(gateway.origin, { waitUntil: "domcontentloaded" });
      await page
        .locator(".inbox-row")
        .first()
        .waitFor({ state: "visible", timeout: 30_000 });
      const firstUsefulFeedMs = Math.round(performance.now() - start);
      for (const machine of machines)
        await page
          .locator(".inbox-row")
          .filter({ hasText: "Fleet acceptance on " + machine.name })
          .waitFor({ state: "visible", timeout: 30_000 });
      await eventually(
        "one browser event socket",
        async () => open.size === 1,
        30_000,
      );
      const allSourcesMs = Math.round(performance.now() - start);
      const tunnelFeedLoaded = await tunnelSnapshot();
      await Promise.all([...sizes]);
      const beforeIdle = { ...metrics },
        idleAt = performance.now();
      await page.waitForTimeout(10_000);
      await Promise.all([...sizes]);
      const delta = (before, at) => ({
        ms: Math.round(performance.now() - at),
        requests: metrics.requests - before.requests,
        responseBytes: metrics.responseBytes - before.responseBytes,
        frames: metrics.frames - before.frames,
        frameBytes: metrics.frameBytes - before.frameBytes,
      });
      const idle = delta(beforeIdle, idleAt);
      const tunnelAfterIdle = await tunnelSnapshot();
      const beforeActive = { ...metrics },
        activeAt = performance.now();
      await page
        .locator(".inbox-row")
        .filter({ hasText: "Fleet acceptance on " + destination.name })
        .click();
      await page
        .locator("dialog.feed-reading-sheet")
        .getByRole("button", { name: "Reply", exact: true })
        .click();
      await engines
        .expect(page)
        .toHaveURL(
          (url) =>
            url.searchParams.get("conversation") ===
              destination.visibleRun.conversation_id &&
            (url.searchParams.get("source") ?? "") ===
              (gateway === destination
                ? ""
                : "peer:" + destination.identity.machineId),
        );
      await page.waitForTimeout(10_000);
      await Promise.all([...sizes]);
      assert.equal(
        errors,
        0,
        "Browser acceptance reported an unexpected page error",
      );
      assert.equal(metrics.maxEventSockets, 1);
      const activeThread = delta(beforeActive, activeAt);
      const tunnelAfterActive = await tunnelSnapshot();
      measurements.push({
        engine,
        gateway: gateway.name,
        firstUsefulFeedMs,
        allSourcesMs,
        idle,
        activeThread,
        receivingTunnels: {
          before: tunnelBefore,
          feedLoaded: tunnelFeedLoaded,
          afterIdle: tunnelAfterIdle,
          afterActive: tunnelAfterActive,
        },
        ...metrics,
      });
    } finally {
      await browser.close();
    }
  }
  return measurements;
}

try {
  report.source = (
    await command("source identity", "git", ["rev-parse", "HEAD"])
  ).stdout.trim();
  report.dirty = !!(
    await command("source status", "git", [
      "status",
      "--porcelain",
      "--untracked-files=no",
    ])
  ).stdout.trim();
  if (values.fixtures) {
    for (const [name, executable, args, suite] of [
      ["check", "npm", ["run", "check"]],
      ["build", "npm", ["run", "build"]],
      [
        "boundary-fixtures",
        process.execPath,
        [
          "scripts/heavy-command.mjs",
          "node_modules/vitest/vitest.mjs",
          "run",
          "test/fleet-admin-http.test.ts",
          "test/fleet-workspace-actions.test.ts",
          "test/fleet-mail-admission.test.ts",
          "test/fleet-mail-outgoing.test.ts",
          "test/fleet-mail-policy.test.ts",
          "test/workspace-multiplex-client.test.ts",
          "--maxWorkers=1",
        ],
        "vitest",
      ],
      [
        "native-fixtures",
        process.execPath,
        [
          "scripts/heavy-command.mjs",
          "--import",
          "tsx",
          "--test",
          "--test-concurrency=1",
          "test/fleet-startup.node.test.ts",
          "test/fleet-workspace-host.node.test.ts",
          "test/fleet-mail-worker.node.test.ts",
          "test/fleet-mail-harness.node.test.ts",
          "test/fleet-acceptance-observations.node.test.ts",
        ],
        "native",
      ],
      [
        "capacity-and-multiplex-measurements",
        process.execPath,
        [
          "scripts/heavy-command.mjs",
          "--import",
          "tsx",
          "--test",
          "--test-concurrency=1",
          "test/fleet-capacity.node.test.ts",
          "test/workspace-multiplex.node.test.ts",
          "test/fleet-multiplex-recovery.node.test.ts",
        ],
        "native",
      ],
      [
        "source-feed-chromium",
        process.execPath,
        ["--import", "tsx", "scripts/fleet-feed-browser-smoke.mjs"],
      ],
      [
        "source-feed-webkit",
        process.execPath,
        ["--import", "tsx", "scripts/fleet-feed-browser-smoke.mjs"],
      ],
      ["chromium", "npm", ["run", "smoke:fleet"]],
      ["webkit", "npm", ["run", "smoke:fleet"]],
      ["package", "npm", ["run", "smoke:package"]],
    ])
      await step(name, async () => {
        const env = testEnvironment(cleanEnv, suite);
        if (name === "webkit" || name === "source-feed-webkit")
          env.LOOP55_BROWSER = "webkit";
        await command(name, executable, args, {
          env,
          timeout: 1_800_000,
          fixtureLog: output + "." + name + ".log",
        });
        // Fixture logs contain only synthetic state. Real-tunnel CLI output is
        // deliberately excluded from this path.
        const log = await readFile(output + "." + name + ".log", "utf8");
        const measurements = fixtureMeasurements(log);
        if (
          [
            "capacity-and-multiplex-measurements",
            "source-feed-chromium",
            "source-feed-webkit",
          ].includes(name)
        )
          assert(
            measurements.length > 0,
            "Expected measured fixture observations",
          );
        return { exit: 0, ...(measurements.length ? { measurements } : {}) };
      });
  } else {
    console.log(
      "Starting THREE test-owned companions behind real Quick Tunnels; no user workspace or provider account is used.",
    );
    console.log("Test-owned workspace directory: " + base);
    const target = join(base, "installed");
    await mkdir(target);
    let tarball = values.package && resolve(values.package);
    await step("package-install", async () => {
      if (!tarball) {
        await command("build", "npm", ["run", "build"]);
        const packed = await command("pack", "npm", [
          "pack",
          "--ignore-scripts",
          "--json",
          "--pack-destination",
          base,
        ]);
        tarball = join(base, JSON.parse(packed.stdout)[0].filename);
      }
      await command("install", "npm", [
        "install",
        "--prefix",
        target,
        "--omit=optional",
        "--no-audit",
        "--no-fund",
        tarball,
      ]);
      return { exit: 0 };
    });
    bin = join(target, "node_modules/.bin/loop55");
    const packageRoot = join(target, "node_modules/loop55");
    report.build = await packageBuild(packageRoot);
    const links = await import(
      pathToFileURL(join(packageRoot, "dist/shared/fleet-pairing.js"))
    );
    let older;
    if (values["upgrade-from"])
      await step("older-package-install", async () => {
        const prefix = join(base, "older-install");
        const env = { ...cleanEnv, npm_config_prefix: prefix };
        await command(
          "install older package",
          "npm",
          [
            "install",
            "-g",
            "--omit=optional",
            "--no-audit",
            "--no-fund",
            resolve(values["upgrade-from"]),
          ],
          { env },
        );
        const packageRoot = join(prefix, "lib/node_modules/loop55");
        older = {
          prefix,
          packageRoot,
          bin: join(prefix, "bin/loop55"),
          build: await packageBuild(packageRoot),
          links: await import(
            pathToFileURL(join(packageRoot, "dist/shared/fleet-pairing.js"))
          ),
        };
        assert.equal(older.build.clean, true);
        assert.equal(report.build.clean, true);
        assert(older.build.commit && report.build.commit);
        assert.notEqual(
          older.build.commit,
          report.build.commit,
          "Upgrade must use different source commits",
        );
        return {
          fromCommit: older.build.commit,
          toCommit: report.build.commit,
        };
      });
    for (const name of ["a", "b", "c"]) {
      const directory = join(base, name),
        project = join(directory, "project"),
        fixture = join(directory, "fixture-harness");
      await mkdir(project, { recursive: true });
      await command("initialize test project", "git", ["init", project]);
      await writeFile(
        join(project, "README.md"),
        "Isolated fleet acceptance fixture.\n",
      );
      await command("stage test project", "git", [
        "-C",
        project,
        "add",
        "README.md",
      ]);
      await command("commit test project", "git", [
        "-C",
        project,
        "-c",
        "user.name=Fleet fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "Test-owned project",
      ]);
      await copyFile(join(root, "test/harness.mjs"), fixture);
      await chmod(fixture, 0o755);
      const audit = join(directory, "native-audit.jsonl");
      const machine = {
        name,
        project,
        fixture,
        audit,
        packageRoot: name === "a" && older ? older.packageRoot : packageRoot,
        links: name === "a" && older ? older.links : links,
        bin: name === "a" && older ? older.bin : bin,
        metrics: { requests: 0, bytes: 0, maxMs: 0 },
        env: {
          ...cleanEnv,
          ...(name === "a" && older ? { npm_config_prefix: older.prefix } : {}),
          LOOP55_HOME: join(directory, "state"),
          LOOP55_TEST_HARNESS: "codex",
          LOOP55_TEST_FLEET_ACCEPTANCE_HELPER: pathToFileURL(
            join(root, "test/fixtures/fleet-acceptance-client.mjs"),
          ).href,
          LOOP55_TEST_FLEET_ACCEPTANCE_AUDIT: audit,
        },
      };
      machines.push(machine);
      await writeFile(
        join(base, "cleanup.json"),
        JSON.stringify(
          {
            version: 1,
            purpose: "isolated-fleet-acceptance",
            cli: bin,
            workspaces: machines.map((item) => ({
              name: item.name,
              cli: machineBin(item),
              loopHome: item.env.LOOP55_HOME,
            })),
          },
          null,
          2,
        ) + "\n",
        { mode: 0o600 },
      );
      await step("launch-" + name, () => launch(machine));
    }
    const [a, b, c] = machines;
    await step("unauthenticated-workspace-refused", async () => {
      for (const machine of machines) {
        const response = await fetch(machine.origin + "/api/bootstrap", {
          redirect: "manual",
          signal: AbortSignal.timeout(30_000),
        });
        assert([401, 403].includes(response.status));
      }
      return { origins: 3 };
    });
    await step("enroll-three-machines", async () => {
      await a.api("/fleet/admin/create", {
        mutationId: randomUUID(),
        name: "Fixture A",
        scope,
        confirm: true,
      });
      await enroll(a, b);
      await enroll(a, c);
      await synchronized(a);
      return { members: 3, acknowledgementsPending: 0 };
    });
    if (older)
      await step("older-source-workspace-upgrade", async () => {
        const priorBuild = await a.api("/build");
        assert.equal(priorBuild.serving.commit, older.build.commit);
        const priorAgent = await a.api("/agents", {
          name: "pre-upgrade-agent",
          connectionId: "native-codex",
          model: "native-default",
        });
        const priorRun = await a.api("/runs", {
          agentId: priorAgent.id,
          input: "Fixture conversation retained across source upgrade",
          idempotencyKey: randomUUID(),
        });
        await eventually("older source task completion", async () => {
          const run = (await a.api("/runs")).find(
            (row) => row.id === priorRun.id,
          );
          assert(!["failed", "cancelled", "interrupted"].includes(run?.state));
          return run?.state === "completed";
        });
        const directory = (await a.api("/fleet/admin/state")).head;
        const migrations = () => {
          const db = new Database(
            retainedPath(
              join(a.env.LOOP55_HOME, "workspace"),
              "loop55.db",
              "loop.db",
            ),
            {
              readonly: true,
              fileMustExist: true,
            },
          );
          try {
            return db
              .prepare("SELECT name FROM schema_migrations ORDER BY name")
              .all()
              .map((row) => row.name);
          } finally {
            db.close();
          }
        };
        const beforeMigrations = migrations();
        const expectedMigrations = (
          await readdir(join(packageRoot, "dist/support/migrations"))
        )
          .filter((name) => name.endsWith(".sql"))
          .map((name) => {
            const match = /^\d+-([a-z0-9]+(?:-[a-z0-9]+)*)\.sql$/.exec(name);
            assert(match, "Packaged migration has a supported name");
            return match[1];
          });
        const expectedAdded = expectedMigrations.filter(
          (name) => !beforeMigrations.includes(name),
        );
        assert(
          expectedAdded.length > 0,
          "Older package must predate the new migrations",
        );
        const priorCapabilities = await b.api(sourcePath(a, "/capabilities"));
        assert.equal(priorCapabilities.fleet.events, false);
        assert(!priorCapabilities.fleet.reads.includes("doneThreadList"));
        // This baseline already supports ordinary peer reads but predates fleet
        // events and Done grouping. Its declared missing feature must fail safely.
        assert(
          (await b.api(sourcePath(a, "/bootstrap"))).agents.some(
            (agent) => agent.id === priorAgent.id,
          ),
        );
        let incompatibleStatus;
        try {
          await b.api(sourcePath(a, "/feed/threads"));
        } catch (error) {
          incompatibleStatus = error.status;
        }
        assert(
          Number.isInteger(incompatibleStatus) &&
            incompatibleStatus >= 400 &&
            incompatibleStatus <= 599,
          "An older peer without Done grouping must refuse that read",
        );
        assert(
          (await a.api("/bootstrap")).agents.some(
            (agent) => agent.id === priorAgent.id,
          ),
        );
        const before = JSON.parse(
          (
            await command(
              "older companion status",
              machineBin(a),
              ["status", "--json"],
              { env: a.env },
            )
          ).stdout,
        );
        const cookie = a.cookie;
        await command(
          "upgrade existing isolated workspace",
          machineBin(a),
          ["upgrade", "--from", tarball],
          { env: a.env },
        );
        const after = JSON.parse(
          (
            await command(
              "upgraded companion status",
              machineBin(a),
              ["status", "--json"],
              { env: a.env },
            )
          ).stdout,
        );
        assert.notEqual(after.pid, before.pid);
        assert.equal(after.url, before.url);
        assert.equal(
          after.connection.service.pid,
          before.connection.service.pid,
        );
        assert.equal(
          after.connection.service.tunnel.pid,
          before.connection.service.tunnel.pid,
        );
        // Deliberately keep the old paired API closure: no new device/session is minted.
        assert.equal(a.cookie, cookie);
        assert.equal(
          (await a.api("/build")).serving.commit,
          report.build.commit,
        );
        assert.deepEqual((await a.api("/fleet/admin/state")).head, directory);
        assert(
          (await a.api("/bootstrap")).agents.some(
            (agent) => agent.id === priorAgent.id,
          ),
        );
        assert.equal(
          (await a.api("/runs")).find((row) => row.id === priorRun.id)?.state,
          "completed",
        );
        const afterMigrations = migrations();
        assert(
          beforeMigrations.every((name) => afterMigrations.includes(name)),
        );
        assert(
          expectedMigrations.every((name) => afterMigrations.includes(name)),
        );
        // Restart intentionally invalidates the issuer's short-lived tokens.
        // A read can expose that refusal before the consumer renews its lease.
        // Wait for the retained grant to converge; no action is resubmitted.
        const peerReadRefusals = {};
        await eventually("upgraded peer credential renewal", async () => {
          try {
            const bootstrap = await b.api(sourcePath(a, "/bootstrap"));
            assert(
              bootstrap.agents.some((agent) => agent.id === priorAgent.id),
            );
            const capabilities = await b.api(sourcePath(a, "/capabilities"));
            if (
              !capabilities.fleet.events ||
              !capabilities.fleet.reads.includes("doneThreadList")
            )
              return false;
            assert(Array.isArray(await b.api(sourcePath(a, "/feed/threads"))));
            return true;
          } catch (error) {
            if (![403, 409, 503].includes(error.status)) throw error;
            peerReadRefusals[error.status] =
              (peerReadRefusals[error.status] ?? 0) + 1;
            return false;
          }
        });
        a.links = links;
        report.pendingLiveCases = report.pendingLiveCases.filter(
          (value) => !value.startsWith("Mixed-version package"),
        );
        return {
          fromCommit: older.build.commit,
          toCommit: report.build.commit,
          unsupportedDoneGroupReadStatus: incompatibleStatus,
          eventsBefore: false,
          eventsAfter: true,
          upgradedDoneGroupRead: true,
          addedMigrations: expectedAdded.length,
          retainedAgent: true,
          retainedCompletedRun: true,
          retainedDirectory: true,
          retainedSession: true,
          retainedConnection: true,
          retainedTunnel: true,
          upgradedPeerRead: true,
          peerReadRefusals,
        };
      });
    await step("source-owned-agents-and-reads", async () => {
      for (const machine of machines) {
        const body = {
          name: "receiver-" + machine.name,
          connectionId: "native-codex",
          model: "native-default",
        };
        machine.agent = await machine.api("/agents", body);
        machine.sender = await machine.api("/agents", {
          ...body,
          name: "sender-" + machine.name,
        });
      }
      for (const gateway of machines)
        for (const destination of machines.filter(
          (machine) => machine !== gateway,
        )) {
          const remote = await gateway.api(
            sourcePath(destination, "/bootstrap"),
          );
          assert(
            remote.agents.some((agent) => agent.id === destination.agent.id),
          );
          assert(!remote.agents.some((agent) => agent.id === gateway.agent.id));
        }
      return { directedReads: 6 };
    });
    await step("three-node-browser-feed-and-traffic", async () => {
      for (const machine of machines) {
        machine.visibleRun = await machine.api("/runs", {
          agentId: machine.agent.id,
          input: "Fleet acceptance on " + machine.name,
          idempotencyKey: randomUUID(),
        });
        await eventually("visible fixture conversation", async () => {
          const runs = await machine.api("/runs");
          const run = runs.find((row) => row.id === machine.visibleRun.id);
          assert(!["failed", "cancelled", "interrupted"].includes(run?.state));
          return run?.state === "completed";
        });
      }
      return [
        ...(await browserMeasurements(a, b)),
        ...(await browserMeasurements(b, a)),
      ];
    });
    await step("authenticated-websocket-both-directions", async () => ({
      a: await socketProbe(a),
      b: await socketProbe(b),
    }));
    await step("remote-command-and-duplicate-receipt", async () => {
      const commandId = randomUUID(),
        body = {
          agentId: b.agent.id,
          input: "Isolated acceptance task",
          idempotencyKey: commandId,
        };
      const options = { headers: { "x-loop55-command-id": commandId } };
      const first = await a.api(sourcePath(b, "/runs"), body, options);
      const repeated = await a.api(sourcePath(b, "/runs"), body, options);
      assert.equal(first.id, repeated.id);
      const runs = await b.api("/runs");
      assert.equal(runs.filter((run) => run.id === first.id).length, 1);
      return { destinationRuns: 1, sameReceipt: true };
    });
    await step("mail-and-authorized-file", async () => {
      await sendCase(a, b, "mail-file", {
        content: "Source-owned fleet attachment\n",
      });
      return confirmMail(a, b, "mail-file", true);
    });
    await step("gateway-loss-after-destination-acceptance", () =>
      gatewayLoss(a, b, c),
    );
    await step(
      "mail-with-browser-closed-beyond-credential-lifetime",
      async () => {
        await sendCase(c, b, "mail-before-closed");
        await confirmMail(c, b, "mail-before-closed");
        await command("stop test controller", machineBin(a), ["stop"], {
          env: a.env,
        });
        await sendCase(c, b, "phone-closed", { delayMs: 660_000 });
        const start = Date.now();
        // No paired HTTP calls, WebSockets, renewal API or controller interaction
        // during this interval. The native worker alone originates delayed mail.
        while (Date.now() - start < 665_000) {
          await delay(
            Math.min(30_000, 665_000 - (Date.now() - start)),
            undefined,
            { signal: abort.signal },
          );
          console.log("fleet acceptance: browser clients remain closed");
        }
        const evidence = await confirmMail(c, b, "phone-closed");
        const browserClosedMs = Date.now() - start;
        await launch(a);
        const state = await a.api("/fleet/admin/state");
        await a.api("/fleet/admin/repair-self", {
          mutationId: randomUUID(),
          expected: state.head,
          confirm: true,
        });
        await synchronized(a);
        return { ...evidence, browserClosedMs, controllerStopped: true };
      },
    );
    await step(
      "all-addresses-change-with-controller-key-surviving",
      async () => {
        const oldOrigins = machines.map((machine) => machine.origin);
        for (const machine of machines)
          await command(
            "stop isolated companion",
            machineBin(machine),
            ["stop"],
            {
              env: machine.env,
            },
          );
        for (const machine of machines) await launch(machine);
        machines.forEach((machine, index) =>
          assert.notEqual(machine.origin, oldOrigins[index]),
        );
        const state = await a.api("/fleet/admin/state");
        await a.api("/fleet/admin/repair-self", {
          mutationId: randomUUID(),
          expected: state.head,
          confirm: true,
        });
        await enroll(a, b, "repair");
        await enroll(a, c, "repair");
        await synchronized(a);
        await sendCase(b, c, "after-repair");
        return {
          changedOrigins: 3,
          ...(await confirmMail(b, c, "after-repair")),
        };
      },
    );
    await step("signed-controller-handoff", async () => {
      const state = await a.api("/fleet/admin/state"),
        operationId = randomUUID();
      let job = await a.api("/fleet/admin/handoff/begin", {
        operationId,
        expected: state.head,
        destination: b.identity,
        confirm: true,
      });
      await eventually("controller handoff", async () => {
        if (job.state === "complete") return true;
        assert.notEqual(job.state, "superseded");
        job = await a.api(
          "/fleet/admin/handoff/" +
            (job.state === "ready" ? "advance" : "reconcile"),
          {
            operationId,
            ...(job.state === "ready" ? {} : { confirm: true }),
          },
        );
        return job.state === "complete";
      });
      await synchronized(b);
      assert.equal(
        (await b.api("/fleet/admin/state")).directory.document.controller
          .machineId,
        b.identity.machineId,
      );
      return { completed: true };
    });
    await step("unavailable-controller-per-member-recovery", async () => {
      const previous = await a.api("/fleet/admin/state");
      assert.equal(
        previous.directory.document.controller.machineId,
        b.identity.machineId,
      );
      const oldGrants = new Map(
        previous.directory.document.members.map((member) => [
          member.machineId,
          member.grantId,
        ]),
      );
      await command("stop test controller", machineBin(b), ["stop"], {
        env: b.env,
      });
      const recovered = await a.api("/fleet/admin/recover", {
        mutationId: randomUUID(),
        name: "Recovered fixture A",
        scope,
        expected: previous.head,
        confirm: true,
      });
      assert.equal(
        recovered.directory.document.controller.machineId,
        a.identity.machineId,
      );
      assert.deepEqual(
        recovered.directory.document.members.map((member) => member.machineId),
        [a.identity.machineId],
      );
      assert.equal(recovered.unconfirmed.length, 2);
      await enroll(a, c, "recover");
      const partial = await a.api("/fleet/admin/state");
      assert.deepEqual(
        partial.unconfirmed.map((member) => member.machineId),
        [b.identity.machineId],
      );
      await launch(b);
      await enroll(a, b, "recover");
      await synchronized(a);
      const final = await a.api("/fleet/admin/state");
      assert.equal(final.unconfirmed.length, 0);
      for (const member of final.directory.document.members)
        assert.notEqual(member.grantId, oldGrants.get(member.machineId));
      await sendCase(c, b, "after-explicit-recovery");
      return {
        explicitConsents: 2,
        unconfirmedMembers: 0,
        ...(await confirmMail(c, b, "after-explicit-recovery")),
      };
    });
    report.httpObservations = machines.map(({ name, metrics }) => ({
      machine: name,
      ...metrics,
    }));
  }
} catch (error) {
  report.failure = error.message.startsWith("Acceptance interrupted")
    ? "interrupted"
    : "Acceptance did not complete; inspect the last case and rerun after resolving it.";
  process.exitCode = 1;
} finally {
  for (const id of planned)
    if (!report.cases.some((entry) => entry.id === id))
      report.cases.push({ id, state: "unrun" });
  let cleanupFailed = false;
  for (const machine of machines) {
    try {
      // Cleanup must run even after abort. The helper recognizes only the CLI's
      // precise already-stopped response and verifies both public status states.
      await stopAcceptanceCompanion((args) =>
        execute(machineBin(machine), args, {
          cwd: root,
          env: machine.env,
          timeout: 300_000,
          maxBuffer: 16_000_000,
        }),
      );
    } catch {
      cleanupFailed = true;
    }
  }
  report.cleanup = cleanupFailed ? "incomplete" : "completed";
  if (cleanupFailed) {
    process.exitCode = 1;
    // This is a test-owned directory, not a token or live workspace path.
    report.cleanupDirectory = base;
    console.error(
      "Test-owned cleanup needs attention at " +
        base +
        "; inspect its own loop55 status --json and stop any remaining processes before removing state.",
    );
  } else await rm(base, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  await writeAcceptanceFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log("Fleet acceptance report: " + output);
}
