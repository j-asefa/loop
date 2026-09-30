import test from "node:test";
import assert from "node:assert/strict";
import { choices } from "../src/local-runtime.js";
import { serviceDefinition } from "../src/service.js";

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

test("login services preserve argument boundaries and own their child lifetime", () => {
  const linux = serviceDefinition(
    "linux",
    "/a b/node",
    "/a b/cli.js",
    "/state%dir",
    "/project with spaces",
    "/bin:/custom/bin",
  );
  assert.match(
    linux,
    /ExecStart="\/a b\/node" "\/a b\/cli.js" "start" "--foreground"/,
  );
  assert.match(linux, /LOOP_HOME=\/state%%dir/);
  assert.match(linux, /KillMode=control-group/);
  const mac = serviceDefinition(
    "darwin",
    "/node",
    "/cli.js",
    "/state",
    "/a & b",
    "/bin",
  );
  assert.match(mac, /<string>\/a &amp; b<\/string>/);
  assert.match(mac, /<key>RunAtLoad<\/key><true\/>/);
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
