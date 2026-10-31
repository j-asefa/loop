import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fixtureMeasurements,
  installedTunnelMeasurements,
  isolateAcceptanceEnvironment,
  safeFailure,
  stopAcceptanceCompanion,
  tunnelMeasurements,
  writeAcceptanceFile,
} from "../scripts/helpers/fleet-acceptance-observations.mjs";

test("acceptance cleanup accepts the production CLI when already fully stopped", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "loop55-acceptance-stopped-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const execute = promisify(execFile);
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LOOP55_HOME: root,
  };
  const commands: string[][] = [];
  const result = await stopAcceptanceCompanion(async (args) => {
    commands.push(args);
    return execute(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", ...args],
      { env, timeout: 15_000 },
    );
  });
  assert.equal(result, "already-stopped");
  assert.deepEqual(commands, [["stop"], ["status", "--json"]]);
});

test("acceptance cleanup retains state on unresolved stop failures and live connections", async () => {
  let statusRead = false;
  await assert.rejects(
    stopAcceptanceCompanion(async (args) => {
      statusRead ||= args[0] === "status";
      throw Object.assign(new Error("private native output"), {
        code: 1,
        stdout: "",
        stderr: "Loop55: Recorded native processes could not be confirmed.",
      });
    }),
    (error: Error) =>
      error.message ===
      "Cleanup could not confirm the isolated companion stopped.",
  );
  assert.equal(statusRead, false, "an unrelated stop error must not be masked");
  await assert.rejects(
    stopAcceptanceCompanion(async (args) => ({
      stdout:
        args[0] === "stop"
          ? '{"stopped":true}'
          : '{"state":"stopped","connection":{"state":"running"}}',
    })),
    /Cleanup could not confirm/,
  );
  await assert.rejects(
    stopAcceptanceCompanion(async (args) => ({
      stdout:
        args[0] === "stop" ? '{"stopped":true}' : "private malformed output",
    })),
    /Cleanup could not confirm/,
  );
  assert.equal(
    await stopAcceptanceCompanion(async (args) => ({
      stdout:
        args[0] === "stop"
          ? '{"stopped":true}'
          : '{"state":"stopped","connection":{"state":"stopped"}}',
    })),
    "stopped",
  );
});

test("real-tunnel commands cannot inherit global Git hooks or Docker configuration", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "loop55-acceptance-environment-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const execute = promisify(execFile);
  const hooks = join(root, "hooks"),
    global = join(root, "global.config"),
    audit = join(root, "hook-audit");
  await mkdir(hooks);
  await writeFile(
    join(hooks, "pre-commit"),
    "#!/usr/bin/env node\nrequire('node:fs').appendFileSync(" +
      JSON.stringify(audit) +
      ", 'ran\\n'); process.exit(1);\n",
    { mode: 0o700 },
  );
  await execute("git", ["config", "--file", global, "core.hooksPath", hooks]);
  const inherited = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: global,
    DOCKER_CONFIG: join(root, "existing-docker-config"),
    DOCKER_HOST: "unix:///var/run/docker.sock",
    NODE_EXTRA_CA_CERTS: "/test-network-ca.pem",
    HTTPS_PROXY: "http://test-proxy.invalid:8080",
  };
  const commit = [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "Fixture",
  ];
  const baseline = join(root, "baseline");
  await execute("git", ["init", baseline], { env: inherited });
  await assert.rejects(
    execute("git", ["-C", baseline, ...commit], { env: inherited }),
  );
  assert.equal(await readFile(audit, "utf8"), "ran\n");

  const isolated = await isolateAcceptanceEnvironment(inherited, root);
  const project = join(root, "project");
  await execute("git", ["init", project], { env: isolated });
  await execute("git", ["-C", project, ...commit], { env: isolated });
  assert.equal(await readFile(audit, "utf8"), "ran\n");
  assert.equal(isolated.HOME, process.env.HOME);
  assert.equal(isolated.NODE_EXTRA_CA_CERTS, inherited.NODE_EXTRA_CA_CERTS);
  assert.equal(isolated.HTTPS_PROXY, inherited.HTTPS_PROXY);
  assert.notEqual(isolated.DOCKER_CONFIG, inherited.DOCKER_CONFIG);
  assert.equal(
    isolated.DOCKER_HOST,
    "unix://" + join(root, "command-config/no-docker.sock"),
  );
  await assert.rejects(lstat(join(root, "command-config/no-docker.sock")), {
    code: "ENOENT",
  });
});

test("report writes replace a symlink without touching its target", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "loop55-acceptance-output-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "private.txt"),
    output = join(root, "report.json");
  await writeFile(target, "Private unrelated content");
  await symlink(target, output);
  await writeAcceptanceFile(output, '{"passed":true}\n');
  assert.equal(await readFile(target, "utf8"), "Private unrelated content");
  assert.equal(await readFile(output, "utf8"), '{"passed":true}\n');
  assert.equal((await lstat(output)).isSymbolicLink(), false);
  assert.equal((await lstat(output)).mode & 0o777, 0o600);
  await writeAcceptanceFile(output, '{"passed":false}\n');
  assert.equal(await readFile(output, "utf8"), '{"passed":false}\n');
  assert.equal(await readFile(target, "utf8"), "Private unrelated content");
});

test("tunnel samples retain their installed connection pin across an application upgrade", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "loop55-acceptance-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "dist"));
  const module = join(root, "dist/tunnel.js");
  const sample = (version: string) =>
    `build_info{version="${version}"} 1\ncloudflared_tunnel_total_requests 7\n`;
  await writeFile(module, 'const RELEASE = "2025.1.2";\n');
  const retained = await installedTunnelMeasurements(root);
  assert.equal(retained(sample("2025.1.2")).state, "observed");
  assert.equal(retained(sample("2026.9.3")).state, "unavailable");
  await writeFile(module, 'const RELEASE = "2026.9.3";\n');
  assert.equal(retained(sample("2025.1.2")).expectedVersion, "2025.1.2");
  assert.equal(retained(sample("2025.1.2")).state, "observed");
  const relaunched = await installedTunnelMeasurements(root);
  assert.equal(relaunched(sample("2026.9.3")).state, "observed");
  assert.equal(relaunched(sample("2025.1.2")).state, "unavailable");
  await writeFile(module, "// No recognized package pin\n");
  await assert.rejects(installedTunnelMeasurements(root), /tunnel pin/);
});

test("acceptance reports parse both Node reporters and browser measurements", () => {
  assert.deepEqual(
    fixtureMeasurements(
      'unrelated output\nℹ FLEET_METRIC {"sources":3}\n# FLEET_METRIC {"sources":16}\nFLEET_METRIC {"browser":true}\n',
    ),
    [{ sources: 3 }, { sources: 16 }, { browser: true }],
  );
});

test("acceptance failures preserve useful numeric diagnostics without credentials", () => {
  const failure = safeFailure({
    name: "AssertionError",
    message: "secret-cookie",
    stdout: "secret-pairing-link",
    expected: 200,
    actual: 403,
    status: 403,
    exit: null,
    stack:
      "Error: secret-cookie\n at pair (file:///private/workspace/scripts/fleet-acceptance.mjs:300:7)\n at async file:///private/workspace/scripts/fleet-acceptance.mjs:1200:11\n at async file:///private/workspace/scripts/fleet-acceptance.mjs:200:5",
  });
  assert.deepEqual(failure, {
    kind: "AssertionError",
    expected: 200,
    actual: 403,
    status: 403,
    source: { file: "fleet-acceptance.mjs", line: 300, column: 7 },
    caller: { file: "fleet-acceptance.mjs", line: 1200, column: 11 },
  });
  assert.deepEqual(
    safeFailure({
      name: "secret",
      expected: "secret",
      actual: { cookie: "secret" },
      exit: Infinity,
      cause: { code: "secret-cookie" },
      phase: "secret-cookie",
    }),
    { kind: "Error" },
  );
  assert.deepEqual(
    safeFailure({
      name: "TypeError",
      cause: { code: "ENOTFOUND", hostname: "secret-origin" },
    }),
    { kind: "TypeError", networkCode: "ENOTFOUND" },
  );
  assert.deepEqual(
    safeFailure({
      name: "TypeError",
      phase: "pair-submit",
      cause: {
        code: "UND_ERR_SOCKET",
        socket: { remoteAddress: "secret-origin" },
      },
    }),
    { kind: "TypeError", phase: "pair-submit", networkCode: "UND_ERR_SOCKET" },
  );
  assert.deepEqual(
    safeFailure({
      name: "TypeError",
      cause: {
        code: "ENETUNREACH",
        errors: [
          {
            code: "ENETUNREACH",
            address: "2001:db8::1",
            hostname: "secret-origin",
          },
          { code: "ETIMEDOUT", address: "192.0.2.1", message: "secret-cookie" },
          { code: "secret", address: "private" },
        ],
      },
    }),
    {
      kind: "TypeError",
      networkCode: "ENETUNREACH",
      networkAttempts: [
        { code: "ENETUNREACH", family: 6 },
        { code: "ETIMEDOUT", family: 4 },
      ],
    },
  );
});

test("tunnel samples require the pinned build and retain only numeric aggregates", () => {
  const text = [
    'build_info{goversion="go1.25",type="",revision="private",version="2026.9.3"} 1',
    'cloudflared_tunnel_total_requests{tunnel_id="private-a"} 12',
    'cloudflared_tunnel_total_requests{tunnel_id="private-b"} 3',
    "cloudflared_tunnel_concurrent_requests_per_tunnel 2",
    "process_resident_memory_bytes 1.5e6",
    "go_memstats_alloc_bytes NaN",
    "cloudflared_tunnel_active_streams -1",
    'private_metric{cookie="secret"} 12',
  ].join("\n");
  const observed = tunnelMeasurements(text, "2026.9.3");
  assert.equal(observed.state, "observed");
  assert.deepEqual(observed.values, {
    cloudflared_tunnel_total_requests: 15,
    cloudflared_tunnel_concurrent_requests_per_tunnel: 2,
    cloudflared_tunnel_request_errors: null,
    cloudflared_tunnel_active_streams: null,
    process_resident_memory_bytes: 1_500_000,
    go_memstats_alloc_bytes: null,
  });
  assert(!/private|secret/.test(JSON.stringify(observed)));
  assert.equal(tunnelMeasurements(text, "different").state, "unavailable");
  assert.equal(tunnelMeasurements("", "2026.9.3").state, "unavailable");
});
