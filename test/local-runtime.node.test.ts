import test from "node:test";
import assert from "node:assert/strict";
import { choices } from "../src/local-runtime.js";
import { repointUnit, serviceDefinitions } from "../src/service.js";

test("local Compose setup upgrades the old capacity without replacing credentials", async () => {
  const { mkdtemp, mkdir, cp, writeFile, readFile, rm } =
    await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const root = await mkdtemp(join(tmpdir(), "loop-capacity-upgrade-"));
  try {
    await mkdir(join(root, "deployment/local"), { recursive: true });
    await mkdir(join(root, "runtime"));
    await mkdir(join(root, ".local-native/secrets/app"), { recursive: true });
    await cp(
      "deployment/local/setup-native.mjs",
      join(root, "deployment/local/setup-native.mjs"),
    );
    await cp("runtime/concurrency.mjs", join(root, "runtime/concurrency.mjs"));
    const path = join(root, ".local-native/secrets/app/environments.json");
    const original = [
      {
        name: "Docker",
        capacity: 4,
        credential: "fixture-only",
        namespace: "preserved",
      },
      { name: "Custom", capacity: 8 },
    ];
    await writeFile(path, JSON.stringify(original));
    const setup = () =>
      promisify(execFile)(process.execPath, [
        join(root, "deployment/local/setup-native.mjs"),
      ]);
    await setup();
    const expected = [{ ...original[0], capacity: 32 }, original[1]];
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), expected);
    await setup();
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider and location choices form independent combinations", () => {
  for (const provider of ["openai", "anthropic", "both"]) {
    for (const execution of ["native", "docker", "both"]) {
      const choice = choices(provider, execution, "/a project");
      assert.equal(choice.execution, execution);
      assert.equal(choice.project, "/a project");
      assert.deepEqual(
        choice.providers,
        provider === "both"
          ? ["codex", "claude"]
          : [provider === "openai" ? "codex" : "claude"],
      );
    }
  }
  assert.throws(() => choices("unknown", "native", "/project"));
  assert.throws(() => choices("openai", "cloud", "/project"));
});

test("managed explicit runtime lists preserve aliases and reject unsupported selections", () => {
  for (const execution of ["native", "docker", "both"]) {
    assert.deepEqual(choices("opencode", execution, "/project").providers, [
      "opencode",
    ]);
    assert.deepEqual(
      choices("codex, opencode,claude,codex", execution, "/project").providers,
      ["codex", "opencode", "claude"],
    );
  }
  assert.deepEqual(choices("pi", "native", "/project").providers, ["pi"]);
  assert.deepEqual(choices("codex,claude,opencode,pi,pi", "docker", "/project").providers, ["codex", "claude", "opencode", "pi"]);
  for (const providers of [
    "",
    "codex,",
    "both,opencode",
    "toString",
    "__proto__",
  ])
    assert.throws(
      () => choices(providers, "native", "/project"),
      /--providers/,
    );
});

test("login services preserve argument boundaries and keep the connection in its own unit", () => {
  const linux = serviceDefinitions(
    "linux",
    "/a b/node",
    "/a b/cli.js",
    "/state%dir",
    "/project with spaces",
    "/bin:/custom/bin",
    ["--tunnel-name", "loop", "--public-url", "https://loop.example"],
  );
  assert.match(
    linux.app.contents,
    /ExecStart="\/a b\/node" "\/a b\/cli.js" "start" "--project" "\/project with spaces" "--foreground"/,
  );
  assert.match(linux.app.contents, /LOOP_HOME=\/state%%dir/);
  // systemd takes WorkingDirectory literally; a quoted path is rejected.
  assert.match(linux.app.contents, /^WorkingDirectory=\/project with spaces$/m);
  assert.match(linux.connection!.contents, /^WorkingDirectory=\/project with spaces$/m);
  // The application's cgroup is its own; restarting it can't reach cloudflared.
  assert.match(linux.app.contents, /KillMode=control-group/);
  assert.match(linux.app.contents, /LOOP_CONNECTION_MANAGED=external/);
  assert.match(linux.app.contents, /Wants=loop-connection.service/);
  assert.doesNotMatch(linux.app.contents, /Requires=|BindsTo=|PartOf=/);
  assert.match(linux.app.contents, /Restart=on-failure/);
  assert.equal(linux.connection!.name, "loop-connection.service");
  assert.match(
    linux.connection!.contents,
    /ExecStart="\/a b\/node" "\/a b\/cli.js" "connection" "--foreground" "--tunnel-name" "loop" "--public-url" "https:\/\/loop.example"/,
  );
  assert.doesNotMatch(linux.connection!.contents, /LOOP_CONNECTION_MANAGED/);
  // The saved launch is repeated; --foreground is added once.
  const harness = serviceDefinitions(
    "linux", "/node", "/cli.js", "/state", "/p", "/bin", [],
    ["codex", "--executable", "/x", "--billing", "existing", "--foreground"],
  );
  assert.match(
    harness.app.contents,
    /ExecStart="\/node" "\/cli.js" "codex" "--executable" "\/x" "--billing" "existing" "--foreground"\n/,
  );
  // Local-only has no tunnel: no connection unit, no external connection.
  const local = serviceDefinitions(
    "linux", "/node", "/cli.js", "/state", "/p", "/bin", null,
    ["start", "--local-only"],
  );
  assert.equal(local.connection, undefined);
  assert.doesNotMatch(local.app.contents, /loop-connection|LOOP_CONNECTION_MANAGED/);
  const mac = serviceDefinitions(
    "darwin",
    "/node",
    "/cli.js",
    "/state",
    "/a & b",
    "/bin",
  );
  assert.match(mac.app.contents, /<string>\/a &amp; b<\/string>/);
  assert.match(mac.app.contents, /<key>RunAtLoad<\/key><true\/>/);
  // KeepAlive only after a failure: loop stop's clean exit is not undone.
  assert.match(
    mac.app.contents,
    /<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/,
  );
  assert.match(mac.connection!.contents, /<string>dev.loop.connection<\/string>/);
  assert.match(mac.connection!.contents, /<string>connection<\/string>/);
});

test("named tunnel reuses credentials and exposes only the authenticated gateway", async () => {
  const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { parse } = await import("yaml");
  const { namedTunnelConfig } = await import("../src/tunnel.js");
  const root = await mkdtemp(join(tmpdir(), "loop-named-config-"));
  try {
    const source = join(root, "original.yml");
    await writeFile(
      source,
      "tunnel: existing-id\ncredentials-file: identity.json\ningress:\n  - service: http://localhost:3010\n",
    );
    const config = await namedTunnelConfig(root, 12345, {
      name: "existing-id",
      origin: "https://loop.example",
      config: source,
    });
    const generated = parse(await readFile(config, "utf8"));
    assert.equal(generated["credentials-file"], join(root, "identity.json"));
    assert.deepEqual(generated.ingress, [
      { hostname: "loop.example", service: "http://127.0.0.1:12345" },
      { service: "http_status:404" },
    ]);
    assert.match(await readFile(source, "utf8"), /3010/);
    await assert.rejects(
      namedTunnelConfig(root, 12345, {
        name: "another-id",
        origin: "https://loop.example",
        config: source,
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("crash recovery stops only containers with the recorded identity", async () => {
  const { mkdtemp, writeFile, readFile, mkdir, rm } =
    await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { stopManagedContainers } = await import("../src/local-runtime.js");
  const root = await mkdtemp(join(tmpdir(), "loop-container-stop-"));
  const oldPath = process.env.PATH;
  try {
    await mkdir(join(root, "managed"));
    const identity = "local-00000000-0000-4000-8000-000000000000";
    const records = join(root, "managed/containers.json");
    await writeFile(
      records,
      JSON.stringify([{ name: "loop-laptop-abc123", identity }]),
    );
    const docker = join(root, "docker");
    await writeFile(
      docker,
      `#!/usr/bin/env node\nif(process.argv[2]==='ps')console.log('loop-laptop-abc123');else if(process.argv[2]==='inspect')console.log('wrong identity');else throw Error('must not stop');\n`,
      { mode: 0o755 },
    );
    process.env.PATH = root + ":" + oldPath;
    await assert.rejects(stopManagedContainers(root), /identity changed/);
    assert.equal(JSON.parse(await readFile(records, "utf8")).length, 1);
    await writeFile(
      docker,
      `#!/usr/bin/env node\nif(process.argv[2]==='ps')console.log('loop-laptop-abc123');else if(process.argv[2]==='inspect')console.log('${identity}');else if(process.argv[2]!=='stop')process.exit(1);\n`,
      { mode: 0o755 },
    );
    assert.equal(await stopManagedContainers(root), 1);
    assert.deepEqual(JSON.parse(await readFile(records, "utf8")), []);
    await writeFile(
      records,
      JSON.stringify([{ name: "loop-laptop-abc123", identity }]),
    );
    await writeFile(docker, "#!/usr/bin/env node\n", { mode: 0o755 });
    assert.equal(await stopManagedContainers(root), 0);
    assert.deepEqual(JSON.parse(await readFile(records, "utf8")), []);
  } finally {
    process.env.PATH = oldPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("an upgrade points the application unit at the new build", () => {
  // bash install leaves the CLI in the checkout the service was installed
  // from; loop upgrade installs into npm's global prefix. Restarting the unit
  // as written would relaunch the checkout, so upgrade reports success while
  // the old release keeps serving.
  const checkout = "/Users/x/src/loop/dist/cli.js";
  const installed = "/opt/homebrew/lib/node_modules/loop/dist/cli.js";
  for (const platform of ["darwin", "linux"]) {
    const units = serviceDefinitions(
      platform,
      "/usr/local/bin/node",
      checkout,
      "/state",
      "/project",
      "/bin",
      [],
      ["codex", "--executable", "/x", "--billing", "existing"],
    );
    const next = repointUnit(platform, units.app.contents, installed)!;
    assert(next, "the unit named a different build");
    assert(next.includes(installed), "the new build is the launch's executable");
    assert(!next.includes(checkout), "the old build is gone from the launch");
    const expected = serviceDefinitions(platform, "/usr/local/bin/node", installed, "/state", "/project", "/bin", [], ["start", "--providers", "codex"]);
    assert.equal(next, expected.app.contents);
    // Pointing it again is a no-op, so a plain restart is left to the manager.
    assert.equal(repointUnit(platform, next, installed), null);
    // A definition Loop cannot read is refused with recovery guidance rather
    // than restarted as if the upgrade had landed.
    assert.throws(
      () => repointUnit(platform, "hand written", installed),
      /loop service install from the new build/,
    );
  }
});

test("an upgrade repoints both units but only reloads the application", async () => {
  const { mkdtemp, mkdir, readFile, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const mac = process.platform === "darwin";
  const home = await mkdtemp(join(tmpdir(), "loop-repoint-"));
  const path = process.env.PATH;
  const HOME = process.env.HOME;
  try {
    const bin = join(home, "bin");
    const calls = join(home, "manager-calls.log");
    await mkdir(bin, { recursive: true });
    const manager = mac ? "launchctl" : "systemctl";
    await writeFile(
      join(bin, manager),
      `#!/bin/sh\necho "$@" >> ${JSON.stringify(calls)}\n`,
      { mode: 0o755 },
    );
    const agents = join(home, mac ? "Library/LaunchAgents" : ".config/systemd/user");
    await mkdir(agents, { recursive: true });
    const { SERVICES, repointAppService, serviceDefinitions } = await import("../src/service.js");
    const names = mac ? SERVICES.darwin : SERVICES.linux;
    const checkout = join(home, "checkout", "dist", "cli.js");
    const installed = join(home, "prefix", "lib", "node_modules", "loop", "dist", "cli.js");
    const units = serviceDefinitions(
      process.platform, process.execPath, checkout, join(home, "state"), home, "/bin", [],
    );
    const file = (name: string) => join(agents, mac ? `${name}.plist` : name);
    await writeFile(file(names.app), units.app.contents);
    await writeFile(file(names.connection), units.connection!.contents);
    process.env.HOME = home;
    process.env.PATH = `${bin}:${path}`;

    assert.equal(await repointAppService(installed), "repointed");
    assert.equal(
      await readFile(file(names.app), "utf8"),
      units.app.contents.replace(checkout, installed),
    );
    // The connection unit's running process holds the tunnel and the public
    // address, so it is never reloaded. Its definition is still pointed at the
    // new build, or the next reboot would start the old release's connection
    // service -- or fail, once that checkout is gone.
    assert.equal(
      await readFile(file(names.connection), "utf8"),
      units.connection!.contents.replace(checkout, installed),
    );
    const asked = await readFile(calls, "utf8");
    assert(asked.includes(names.app), "the application unit was reloaded");
    assert(!asked.includes(names.connection), "the connection unit was not: " + asked);

    // Already the installed build: the caller restarts it the usual way. The
    // connection unit is already pointed too, so nothing is rewritten.
    assert.equal(await repointAppService(installed), "unchanged");
    const { installedSupervisor } = await import("../src/service.js");
    assert.equal(
      await installedSupervisor(join(home, "state")),
      mac ? "launchd" : "systemd",
    );
    // A unit installed for someone else's workspace is not this one's to
    // restart, however this CLI was invoked.
    assert.equal(await installedSupervisor(join(home, "other-state")), undefined);
    // No installation to point at all.
    await rm(file(names.app));
    assert.equal(await repointAppService(installed), "absent");
    // Nothing installed: a restart has no manager to route to.
    assert.equal(await installedSupervisor(join(home, "state")), undefined);
  } finally {
    if (HOME === undefined) delete process.env.HOME;
    else process.env.HOME = HOME;
    process.env.PATH = path;
    await rm(home, { recursive: true, force: true });
  }
});

 test("upgrades saved direct and ACP service launches on both service managers", () => {
  for (const platform of ["darwin", "linux"]) {
    for (const launch of [
      ["start", "--project=/project", "--direct", "--local-only"],
      ["acp", "--project", "/project", "--executable", "/retired", "--acp-arg=x", "--billing", "existing", "--local-only"],
    ]) {
      const old = serviceDefinitions(platform, "/node", "/old", "/state", "/project", "/bin", null, launch);
      const actual = repointUnit(platform, old.app.contents, "/new");
      const expected = serviceDefinitions(platform, "/node", "/new", "/state", "/project", "/bin", null, ["start", "--project", "/project", "--local-only"]);
      assert.equal(actual, expected.app.contents);
    }
  }
});
