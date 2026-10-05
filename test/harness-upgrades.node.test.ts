import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  HarnessUpgrades,
  nativeHelperInstall,
  upgradePlan,
  type UpgradeRunner,
} from "../src/harness-upgrades.js";
import { until } from "./helpers.js";
function fixture(t: any) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "harness-upgrades-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function script(file: string, body: string) {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
}
const packages = {
  codex: "@openai/codex",
  claude: "@anthropic-ai/claude-code",
  pi: "@earendil-works/pi-coding-agent",
  opencode: "opencode-ai",
} as const;

// Every upgrade test injects this runner, so no test spawns a package manager
// or reaches a registry. `installed` is what `--version` reports.
function fakeRunner(
  installed: { version?: string },
  install: (command: string, args: string[]) => void | Promise<void>,
  latest = "0.160.0",
) {
  const calls: string[][] = [];
  const run: UpgradeRunner = async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === "--version") {
      if (!installed.version) throw new Error("unreadable");
      return `codex-cli ${installed.version}\n`;
    }
    if (command === "npm" && args[0] === "view") return latest + "\n";
    await install(command, args);
    return "secret installer output";
  };
  return { run, calls };
}
function npmGlobal(dir: string) {
  const prefix = join(dir, "different-prefix");
  const executable = join(prefix, "lib/node_modules/@openai/codex/bin/codex.js");
  script(executable, 'process.exit(97)');
  writeFileSync(
    join(prefix, "lib/node_modules/@openai/codex/package.json"),
    JSON.stringify({ name: packages.codex }),
  );
  return { prefix, executable };
}
const settled = (manager: HarnessUpgrades, name: "codex" | "pi" | "claude" | "opencode") =>
  until(() => manager.status(name)?.state !== "running", 5000);

test("upgrades the owning npm prefix to the resolved release, verifies it and never repeats an operation ID", async (t) => {
  const dir = fixture(t);
  const { prefix, executable } = npmGlobal(dir);
  const installed = { version: "0.157.0" };
  const { run, calls } = fakeRunner(installed, () => {
    installed.version = "0.160.0";
  });
  const manager = new HarnessUpgrades(join(dir, "state/upgrades.json"), run);
  const id = randomUUID();
  manager.start("codex", executable, id);
  assert.equal(manager.start("codex", executable, id).state, "running");
  assert.throws(() => manager.start("pi", executable, id), /another runtime/);
  assert.throws(
    () => manager.start("codex", executable, randomUUID()),
    /in progress/,
  );
  // Only the harness being upgraded is held.
  assert.equal(manager.busy("codex"), true);
  assert.equal(manager.busy("claude"), false);
  await settled(manager, "codex");
  const done = manager.status("codex")!;
  assert.equal(done.state, "complete");
  assert.equal(done.version, "0.160.0");
  assert.equal(done.previous, "0.157.0");
  assert.match(done.message, /Upgraded from 0\.157\.0 to 0\.160\.0/);
  assert.equal(manager.busy("codex"), false);
  assert.deepEqual(
    calls.filter(([command, arg]) => command === "npm" && arg === "install"),
    [["npm", "install", "--global", "--prefix", prefix, "@openai/codex@0.160.0"]],
  );
  assert(!JSON.stringify(done).includes("secret installer output"));
  assert(!JSON.stringify(done).includes(executable), "status never exposes the path");
  const restarted = new HarnessUpgrades(join(dir, "state/upgrades.json"), run);
  await restarted.ready;
  assert.equal(restarted.start("codex", executable, id).state, "complete");
  assert.equal(calls.filter(([, arg]) => arg === "install").length, 1);
});

test("an install that does not reach the resolved release fails and rolls back once", async (t) => {
  const dir = fixture(t);
  const { prefix, executable } = npmGlobal(dir);
  const installed = { version: "0.157.0" };
  const { run, calls } = fakeRunner(installed, (_command, args) => {
    // The upgrade lands an older release than resolved; the rollback works.
    installed.version = args.at(-1)!.endsWith("@0.160.0") ? "0.159.0" : "0.157.0";
  });
  const manager = new HarnessUpgrades(join(dir, "upgrades.json"), run);
  manager.start("codex", executable, randomUUID());
  await settled(manager, "codex");
  const failed = manager.status("codex")!;
  assert.equal(failed.state, "failed");
  assert.match(failed.message, /0\.159\.0 is installed instead of 0\.160\.0/);
  assert.match(failed.message, /Rolled back to 0\.157\.0\./);
  assert.equal(failed.version, "0.157.0");
  assert.deepEqual(
    calls.filter(([, arg]) => arg === "install").map((c) => c.at(-1)),
    ["@openai/codex@0.160.0", "@openai/codex@0.157.0"],
  );
  assert.equal(calls.find((c) => c[1] === "install")![4], prefix);
});

test("a timed-out installer ends failed, reports an unsuccessful rollback and does not hold runs", async (t) => {
  const dir = fixture(t);
  const { executable } = npmGlobal(dir);
  const installed: { version?: string } = { version: "0.157.0" };
  const { run, calls } = fakeRunner(installed, () => {
    installed.version = undefined;
    throw Object.assign(new Error("killed"), { killed: true });
  });
  const manager = new HarnessUpgrades(join(dir, "upgrades.json"), run);
  manager.start("codex", executable, randomUUID());
  await settled(manager, "codex");
  const failed = manager.status("codex")!;
  assert.equal(failed.state, "failed");
  assert.match(failed.message, /timed out/);
  assert.match(failed.message, /Rollback to 0\.157\.0 failed; the installed version could not be read/);
  assert.equal(calls.filter(([, arg]) => arg === "install").length, 2, "one rollback attempt only");
  assert.equal(manager.busy("codex"), false);
  // Retry is a new explicit operation.
  installed.version = "0.157.0";
  const retry = randomUUID();
  manager.start("codex", executable, retry);
  assert.equal(manager.status("codex")?.commandId, retry);
  await settled(manager, "codex");
});

test("unchanged or unverifiable versions are never reported as upgraded", async (t) => {
  const dir = fixture(t);
  const brew = join(dir, "Cellar/codex/0.157.0/bin/codex");
  script(brew, "process.exit(97)");
  const installed = { version: "0.157.0" };
  const { run } = fakeRunner(installed, () => {});
  const manager = new HarnessUpgrades(join(dir, "upgrades.json"), run);
  manager.start("codex", brew, randomUUID());
  await settled(manager, "codex");
  assert.equal(manager.status("codex")?.state, "complete");
  assert.equal(manager.status("codex")?.message, "Already up to date: 0.157.0 is installed.");
  const unreadable = fakeRunner({}, () => {});
  const other = new HarnessUpgrades(join(dir, "other.json"), unreadable.run);
  other.start("codex", brew, randomUUID());
  await settled(other, "codex");
  assert.equal(other.status("codex")?.state, "failed");
  assert.match(other.status("codex")!.message, /version could not be read.*not reinstalled/);
  // Homebrew cannot reinstall a chosen earlier version.
  const regress = { version: "0.157.0" };
  const downgraded = fakeRunner(regress, () => {
    regress.version = "0.150.0";
  });
  const third = new HarnessUpgrades(join(dir, "third.json"), downgraded.run);
  third.start("codex", brew, randomUUID());
  await settled(third, "codex");
  assert.equal(third.status("codex")?.state, "failed");
  assert.match(third.status("codex")!.message, /Homebrew cannot reinstall 0\.157\.0/);
  assert.equal(downgraded.calls.filter(([c]) => c.endsWith("brew")).length, 1);
  const brewOpencode = join(dir, "Cellar/opencode/1.18.32/bin/opencode");
  script(brewOpencode, "process.exit(97)");
  const fourth = new HarnessUpgrades(join(dir, "fourth.json"), downgraded.run);
  regress.version = "0.157.0";
  fourth.start("opencode", brewOpencode, randomUUID());
  await settled(fourth, "opencode");
  assert.match(fourth.status("opencode")!.message, /Homebrew cannot reinstall/);
  assert.deepEqual(downgraded.calls.at(-2), [join(dir, "bin/brew"), "upgrade", "opencode"]);
});

test("self-updating installers roll back through their own version selection", async (t) => {
  const dir = fixture(t);
  const opencode = join(dir, "opencode");
  script(opencode, "process.exit(97)");
  const installed: { version?: string } = { version: "1.18.32" };
  const { run, calls } = fakeRunner(installed, (_command, args) => {
    // The self-upgrade fails and leaves an unreadable executable behind.
    installed.version = args[1];
    if (!args[1]) throw new Error("self-upgrade failed");
  });
  const manager = new HarnessUpgrades(join(dir, "upgrades.json"), run);
  manager.start("opencode", opencode, randomUUID());
  await settled(manager, "opencode");
  assert.equal(manager.status("opencode")?.state, "failed");
  assert.match(manager.status("opencode")!.message, /installer reported an error\. Rolled back to 1\.18\.32\./);
  assert.deepEqual(
    calls.filter(([, arg]) => arg === "upgrade").map((c) => c.slice(1)),
    [["upgrade"], ["upgrade", "1.18.32"]],
  );
});

test("unresolvable releases change nothing", async (t) => {
  const dir = fixture(t);
  const { executable } = npmGlobal(dir);
  const { run, calls } = fakeRunner({ version: "0.157.0" }, () => {}, "");
  const manager = new HarnessUpgrades(join(dir, "upgrades.json"), run);
  manager.start("codex", executable, randomUUID());
  await settled(manager, "codex");
  assert.equal(manager.status("codex")?.state, "failed");
  assert.match(manager.status("codex")!.message, /nothing was changed/);
  assert.equal(calls.filter(([, arg]) => arg === "install").length, 0);
});

test("recognizes all npm harnesses and private helpers without modifying project dependencies", (t) => {
  const dir = fixture(t);
  for (const [name, pkg] of Object.entries(packages)) {
    const base = join(dir, "helpers/native");
    const file = join(base, "node_modules", pkg, "bin/run.js");
    script(file, 'console.log("1.0.0")');
    writeFileSync(
      join(base, "node_modules", pkg, "package.json"),
      JSON.stringify({ name: pkg }),
    );
    assert.deepEqual(upgradePlan(name as keyof typeof packages, file), {
      command: "npm",
      args: ["install", "--prefix", base, "--save-exact", pkg + "@latest"],
    });
  }
  const custom = join(dir, "project/node_modules/@openai/codex/bin/run.js");
  script(custom, 'console.log("1.0.0")');
  writeFileSync(
    join(dir, "project/node_modules/@openai/codex/package.json"),
    JSON.stringify({ name: packages.codex }),
  );
  assert.throws(() => upgradePlan("codex", custom), /custom installation/);
});

test("keeps launch symlinks for native Claude, recognizes brew, and refuses guarded OpenCode", (t) => {
  const dir = fixture(t);
  const claude = join(dir, ".local/share/claude/versions/2.1.280");
  script(claude, 'console.log("2.1.280")');
  const launcher = join(dir, "claude");
  symlinkSync(claude, launcher);
  assert.deepEqual(upgradePlan("claude", launcher), {
    command: launcher,
    args: ["update"],
  });
  const brew = join(dir, "Cellar/codex/0.157.0/bin/codex");
  script(brew, 'console.log("0.157.0")');
  assert.deepEqual(upgradePlan("codex", brew), {
    command: join(dir, "bin/brew"),
    args: ["upgrade", "codex"],
  });
  const guarded = join(dir, "helpers/opencode-identity/bin/opencode");
  script(guarded, 'console.log("1.18.32")');
  assert.throws(() => upgradePlan("opencode", guarded), /guarded build/);
  const opencode = join(dir, "opencode");
  script(opencode, 'console.log("1.18.32")');
  assert.deepEqual(upgradePlan("opencode", opencode), {
    command: opencode,
    args: ["upgrade"],
  });
});

test("a restart reconciles interrupted upgrades to terminal states without replay", async (t) => {
  const dir = fixture(t);
  const file = join(dir, "status.json");
  const executable = join(dir, "codex");
  script(executable, "process.exit(97)");
  const [reached, interrupted, legacy] = [randomUUID(), randomUUID(), randomUUID()];
  writeFileSync(
    file,
    JSON.stringify({
      [reached]: { commandId: reached, name: "codex", state: "running", message: "Upgrading", executable, previous: "0.157.0", target: "0.160.0" },
      [interrupted]: { commandId: interrupted, name: "claude", state: "running", message: "Upgrading", executable, previous: "0.160.0", target: "0.161.0" },
      // State left by an earlier build: no executable to re-probe.
      [legacy]: { commandId: legacy, name: "pi", state: "unknown", message: "Upgrading" },
    }),
  );
  let probe!: () => void;
  const probing = new Promise<void>((resolve) => (probe = resolve));
  const { run, calls } = fakeRunner({ version: "0.160.0" }, () => {
    throw new Error("an interrupted upgrade must not be replayed");
  });
  const manager = new HarnessUpgrades(file, async (command, args, options) => {
    await probing;
    return run(command, args, options);
  });
  // Until confirmed, only the affected harnesses are held.
  assert.equal(manager.busy("codex"), true);
  assert.equal(manager.busy("opencode"), false);
  assert.throws(() => manager.reserve("opencode"), /confirming/);
  probe();
  await manager.ready;
  assert.equal(manager.status("codex")?.state, "complete");
  assert.match(manager.status("codex")!.message, /restarted during the upgrade; 0\.160\.0 is installed/);
  assert.equal(manager.status("claude")?.state, "failed");
  assert.match(manager.status("claude")!.message, /not retried or rolled back/);
  assert.equal(manager.status("pi")?.state, "failed");
  assert.deepEqual(calls.map((c) => c.slice(1)), [["--version"], ["--version"]]);
  for (const name of ["codex", "claude", "pi"]) assert.equal(manager.busy(name), false);
  assert.equal(manager.start("claude", executable, interrupted).state, "failed");
  // Reconciliation is persisted.
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(Object.values(saved).map((r: any) => r.state), ["complete", "failed", "failed"]);
});

test("reservations make the active-run check and upgrade start atomic per harness", (t) => {
  const dir = fixture(t);
  const manager = new HarnessUpgrades(join(dir, "upgrades.json"), fakeRunner({}, () => {}).run);
  // Runs whose harness is unknown are never held by an idle manager.
  assert.equal(manager.busy(undefined as unknown as string), false);
  const release = manager.reserve("codex");
  assert.equal(manager.busy("codex"), true);
  assert.equal(manager.busy("pi"), false);
  assert.throws(() => manager.reserve("pi"), /in progress/);
  release();
  assert.equal(manager.busy("codex"), false);
  const next = manager.reserve("pi");
  // A stale release never frees a later holder.
  release();
  assert.equal(manager.busy("pi"), true);
  next();
});

test("finished outcomes can be dismissed without allowing their operation to rerun", async (t) => {
  const dir = fixture(t);
  const { executable } = npmGlobal(dir);
  const { run, calls } = fakeRunner({ version: "0.157.0" }, () => {
    throw new Error("secret credential");
  });
  const manager = new HarnessUpgrades(join(dir, "upgrades.json"), run);
  const id = randomUUID();
  manager.start("codex", executable, id);
  assert.throws(() => manager.dismiss("codex"), /finish/);
  await settled(manager, "codex");
  assert.equal(manager.status("codex")?.state, "failed");
  assert(!JSON.stringify(manager.status("codex")).includes("secret credential"));
  manager.dismiss("codex");
  assert.equal(manager.status("codex"), null);
  assert.equal(manager.start("codex", executable, id).state, "failed");
  assert.equal(calls.filter(([, arg]) => arg === "install").length, 1);
  assert.equal(
    new HarnessUpgrades(join(dir, "upgrades.json"), run).status("codex"),
    null,
  );
});

test("shipped helper pins reach existing installs without downgrading a newer in-app upgrade", (t) => {
  const dir = fixture(t);
  const source = join(dir, "shipped");
  const helpers = join(dir, "helpers/native");
  mkdirSync(source, { recursive: true });
  mkdirSync(helpers, { recursive: true });
  const ship = (dependencies: Record<string, string>) => {
    writeFileSync(join(source, "package.json"), JSON.stringify({ dependencies }));
    writeFileSync(join(source, "package-lock.json"), JSON.stringify({ shipped: dependencies }));
  };
  const installedManifest = () => JSON.parse(readFileSync(join(helpers, "package.json"), "utf8")).dependencies;
  const pins = { "@openai/codex": "0.159.0", "@anthropic-ai/claude-code": "2.1.280" };
  ship(pins);
  assert.deepEqual(nativeHelperInstall(helpers, source), ["ci", "--omit=dev"]);
  assert.deepEqual(installedManifest(), pins);
  // An in-app upgrade rewrote the private manifest past the shipped pin.
  writeFileSync(join(helpers, "package.json"), JSON.stringify({ dependencies: { ...pins, "@openai/codex": "0.161.0" } }));
  // A Loop release bumps another pin: it is taken, the newer upgrade is kept.
  ship({ ...pins, "@anthropic-ai/claude-code": "2.1.290" });
  assert.deepEqual(nativeHelperInstall(helpers, source), [
    "install", "--omit=dev", "--save-exact", "@openai/codex@0.161.0",
  ]);
  assert.deepEqual(installedManifest(), { ...pins, "@anthropic-ai/claude-code": "2.1.290" });
  assert.equal(readFileSync(join(helpers, "package-lock.json"), "utf8"), readFileSync(join(source, "package-lock.json"), "utf8"));
  // npm records the reapplied upgrade; a later release shipping a newer pin wins.
  writeFileSync(join(helpers, "package.json"), JSON.stringify({ dependencies: { ...pins, "@openai/codex": "0.161.0" } }));
  ship({ ...pins, "@openai/codex": "0.162.0" });
  assert.deepEqual(nativeHelperInstall(helpers, source), ["ci", "--omit=dev"]);
  assert.equal(installedManifest()["@openai/codex"], "0.162.0");
});

test("Loop's shipped codex pin replaces an older helper manifest", (t) => {
  const dir = fixture(t);
  const helpers = join(dir, "helpers/native");
  mkdirSync(helpers, { recursive: true });
  const source = join(import.meta.dirname, "../deployment/native");
  const shipped = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  writeFileSync(
    join(helpers, "package.json"),
    JSON.stringify({ ...shipped, dependencies: { ...shipped.dependencies, "@openai/codex": "0.157.0" } }),
  );
  assert.deepEqual(nativeHelperInstall(helpers, source), ["ci", "--omit=dev"]);
  assert.deepEqual(JSON.parse(readFileSync(join(helpers, "package.json"), "utf8")), shipped);
});
