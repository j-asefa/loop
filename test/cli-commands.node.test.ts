import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  rm,
  readFile,
  writeFile,
  realpath,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  cliDependencies,
  resolveStart,
  startCommand,
  statusCommand,
  stopCommand,
  restartCommand,
  doctorCommand,
  logsCommand,
  recoverExecutionCommand,
  uninstallCommand,
  helpCommand,
  versionCommand,
  type CommandInput,
  type CliDependencies,
} from "../src/cli.js";
import { writeLaunch } from "../src/launch-record.js";

async function workspace() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "loop-cli-command-")),
  );
  const dir = join(root, "workspace");
  await mkdir(dir);
  const output: string[] = [];
  const deps = cliDependencies({
    root,
    cwd: root,
    log: (s) => output.push(s),
    error: (s) => output.push(s),
    write: (s) => output.push(String(s)),
    discover: async (name) => ({
      name: name === "acp" ? "codex" : name,
      installed: true,
      executable: process.execPath,
      supported: false,
      help: "fixture missing harness",
    }),
    waits: { stop: 37, stopGrace: 25, connection: 50, connectionStart: 50 },
  });
  return {
    root,
    dir,
    deps,
    output,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
const input = (
  action: string,
  values: CommandInput["values"] = {},
): CommandInput => ({ positionals: [action], values });

test("malformed workspace records are reported and preserved instead of treated as stopped", async () => {
  const w = await workspace();
  try {
    await statusCommand(input("status"), w.deps);
    assert.equal(JSON.parse(w.output.pop()!).state, "stopped");
    await assert.rejects(
      stopCommand(input("stop"), w.deps),
      /No workspace is running/,
    );
    for (const contents of [
      "{",
      "null",
      JSON.stringify({ port: 0, token: "x" }),
    ]) {
      await writeFile(join(w.dir, "control.json"), contents);
      for (const [action, command] of [
        ["status", statusCommand],
        ["stop", stopCommand],
        ["restart", restartCommand],
        ["start", startCommand],
      ] as const) {
        await assert.rejects(
          command(input(action, { "local-only": true }), w.deps),
          /Invalid local host record/,
        );
        assert.equal(
          await readFile(join(w.dir, "control.json"), "utf8"),
          contents,
        );
      }
    }
    await doctorCommand(input("doctor"), w.deps);
    const doctor = JSON.parse(w.output.pop()!);
    assert.equal(doctor.workspace.state, "invalid");
    assert.match(doctor.workspace.message, /Invalid local host record/);
    assert(Array.isArray(doctor.harnesses));
    assert.equal(
      await readFile(join(w.dir, "control.json"), "utf8"),
      JSON.stringify({ port: 0, token: "x" }),
    );
    const control = JSON.stringify({ port: 1, token: "x" });
    await writeFile(join(w.dir, "control.json"), control);
    await writeFile(join(w.dir, "host.lock"), "{");
    await assert.rejects(
      statusCommand(input("status"), w.deps),
      /Invalid workspace ownership record/,
    );
    await assert.rejects(
      stopCommand(input("stop"), w.deps),
      /Invalid workspace ownership record/,
    );
    assert.equal(await readFile(join(w.dir, "control.json"), "utf8"), control);
    assert.equal(await readFile(join(w.dir, "host.lock"), "utf8"), "{");
  } finally {
    await w.cleanup();
  }
});

test("local-only overrides a saved public URL and named tunnel", async () => {
  const w = await workspace();
  try {
    writeLaunch(w.dir, {
      schema: 1,
      kind: "workspace",
      action: "start",
      publicUrl: "https://saved-tunnel.invalid",
      tunnelName: "saved-tunnel",
      tunnelConfig: "/nonexistent/tunnel.yml",
    });
    const plan = await resolveStart(
      input("start", { "local-only": true }),
      w.deps,
    );
    assert.equal(plan.kind, "launch");
    assert.equal(plan.launch.localOnly, true);
    assert.equal(plan.launch.publicUrl, undefined);
    assert.equal(plan.launch.tunnelName, undefined);
    assert.equal(plan.tunnelMode, undefined);
    assert.equal(plan.launch.project, w.root);
    const saved = await resolveStart(input("start"), w.deps);
    assert.equal(saved.kind, "launch");
    assert.equal(saved.launch.publicUrl, "https://saved-tunnel.invalid");
    assert.equal(saved.launch.tunnelConfig, "/nonexistent/tunnel.yml");
    await logsCommand(input("logs"), w.deps);
    assert.equal(
      w.output.pop(),
      "No workspace logs yet at " + join(w.dir, "daemon.log"),
    );
    await recoverExecutionCommand(input("recover-execution"), w.deps);
    assert.equal(
      w.output.pop(),
      "No retained execution owner. No records changed.",
    );
    await uninstallCommand(input("uninstall"), w.deps);
    assert.match(w.output.pop()!, /Workspace and native history retained/);
    helpCommand(w.deps);
    assert.match(w.output.pop()!, /loop start/);
    versionCommand(w.deps);
    assert.match(w.output.pop()!, /^\d+\.\d+\.\d+/);
  } finally {
    await w.cleanup();
  }
});

test("loop acp refuses a relative or missing executable with setup guidance", async () => {
  const w = await workspace();
  try {
    for (const executable of ["./missing-agent", "/missing/acp-agent"])
      await assert.rejects(
        startCommand(input("acp", { executable, "local-only": true }), w.deps),
        /Choose an executable local ACP agent file/,
      );
    for (const [action, values, message] of [
      [
        "start",
        { "local-only": true, "public-url": "https://x.example" },
        /Choose --local-only or --public-url/,
      ],
      ["start", { billing: "existing" }, /Runtime options belong/],
      ["start", { providers: "invalid" }, /Choose installed/],
      ["acp", {}, /ACP setup requires/],
      ["codex", {}, /fixture missing harness/],
      ["unknown", {}, /Unknown command/],
    ] as const)
      await assert.rejects(
        startCommand(input(action, values), w.deps),
        message,
      );
    const discovered: CliDependencies = {
      ...w.deps,
      discover: async (name) => ({
        name: name === "acp" ? "codex" : name,
        installed: true,
        supported: true,
        version: "fixture",
        executable: process.execPath,
        help: "",
      }),
    };
    for (const action of [
      "codex",
      "claude",
      "pi",
      "opencode",
      "antigravity",
      "muse",
      "grok",
      "acp",
    ]) {
      const plan = await resolveStart(
        input(action, {
          executable: process.execPath,
          billing: "existing",
          "local-only": true,
          ...(action === "acp" ? { "acp-arg": ["agent"] } : {}),
        }),
        discovered,
      );
      assert.equal(plan.kind, "launch");
      assert.equal(plan.launch.action, action);
      assert.equal(plan.launch.billing, "existing");
      assert.equal(plan.launch.executable, process.execPath);
    }
    const running: CliDependencies = {
      ...discovered,
      status: async () => ({
        state: "responding",
        record: { state: "running", pid: 123, identity: "fixture" },
        status: { project: w.root, connection: { mode: "local" } },
      }),
    };
    for (const [action, values, message] of [
      ["start", { project: resolve(".") }, /Run loop stop before changing/],
      ["start", { providers: "codex" }, /Run loop stop before changing/],
      ["start", { fleet: true }, /Fleets are off/],
      ["codex", { resume: "native" }, /Open native history/],
    ] as const) {
      const plan = await resolveStart(input(action, values), running);
      assert.equal(plan.kind, "launch");
      assert.match(plan.runningRefusal?.message ?? "", message);
      await assert.rejects(
        startCommand(input(action, values), running),
        message,
      );
    }
    assert.equal(
      existsSync(join(w.dir, "launch.json")),
      false,
      "decisions do not persist a launch",
    );
  } finally {
    await w.cleanup();
  }
});

test("invalid named tunnel startup does not save a launch", async () => {
  const w = await workspace();
  try {
    await assert.rejects(
      startCommand(
        input("codex", {
          "tunnel-name": "fixture",
          "public-url": "https://fixture.example/path",
        }),
        w.deps,
      ),
      /bare HTTPS origin/,
    );
    assert.equal(existsSync(join(w.dir, "launch.json")), false);
    await assert.rejects(
      startCommand(input("start", { "tunnel-name": "fixture" }), w.deps),
      /requires --public-url/,
    );
  } finally {
    await w.cleanup();
  }
});
