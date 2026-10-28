import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  realpathSync,
  existsSync,
  openSync,
  closeSync,
  fsyncSync,
  copyFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
const exec = promisify(execFile);
export type UpgradeHarness =
  | "codex"
  | "claude"
  | "pi"
  | "opencode"
  | "antigravity"
  | "gemini"
  | "muse"
  | "grok";
export type Upgrade = {
  commandId: string;
  name: UpgradeHarness;
  state: "running" | "complete" | "failed" | "unconfirmed" | "restart-required";
  message: string;
  version?: string;
  previous?: string;
  target?: string;
};
// The executable stays on the computer; status responses never include it.
type UpgradeRecord = Upgrade & {
  executable?: string;
  dismissed?: boolean;
  restartRequired?: boolean;
};
// Runs one command without a shell and returns its stdout. Tests inject a fake
// so no test path can reach a real package manager.
export type UpgradeRunner = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number },
) => Promise<string>;
// Muse Code and Grok Build are not npm packages; they update themselves.
const packages: Partial<Record<UpgradeHarness, string>> = {
  codex: "@openai/codex",
  claude: "@anthropic-ai/claude-code",
  pi: "@earendil-works/pi-coding-agent",
  opencode: "opencode-ai",
  gemini: "@google/gemini-cli",
};
const READY =
  "New sessions use the updated runtime; refresh its models before creating an agent.";
const CHECK =
  "Check the installation and package manager permissions on the computer before trying again.";

export function compareVersions(a: string, b: string) {
  const parse = (v: string) => {
    const [core, pre] = v.split("+")[0].split(/-(.*)/);
    return { parts: core.split(".").map(Number), pre };
  };
  const x = parse(a),
    y = parse(b);
  for (let i = 0; i < 3; i++)
    if ((x.parts[i] || 0) !== (y.parts[i] || 0))
      return (x.parts[i] || 0) > (y.parts[i] || 0) ? 1 : -1;
  // A release sorts after its own prereleases.
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre > y.pre ? 1 : -1;
}
const exact = (version: unknown): version is string =>
  typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version);

// Loop ships exact pins for its private helper tree, and an in-app upgrade
// rewrites that tree's manifest. Always restore the shipped manifest and
// lockfile, so a bumped pin reaches existing installs, then reapply only the
// upgrades still newer than their shipped pin: a deliberate upgrade is never
// downgraded, and a newer shipped pin always wins. Returns the npm arguments
// that install the resulting tree.
export function nativeHelperInstall(directory: string, source: string) {
  const shipped: Record<string, string> = JSON.parse(
    readFileSync(join(source, "package.json"), "utf8"),
  ).dependencies;
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(
      readFileSync(join(directory, "package.json"), "utf8"),
    ).dependencies;
  } catch {
    /* first install */
  }
  const newer = Object.entries(shipped).flatMap(([name, pin]) => {
    const installed = current?.[name];
    return exact(installed) && compareVersions(installed, pin) > 0
      ? [name + "@" + installed]
      : [];
  });
  for (const file of ["package.json", "package-lock.json"])
    copyFileSync(join(source, file), join(directory, file));
  return newer.length
    ? ["install", "--omit=dev", "--save-exact", ...newer]
    : ["ci", "--omit=dev"];
}

export function upgradeLauncher(name: UpgradeHarness, executable: string) {
  const real = realpathSync(executable);
  const brew = real.match(/^(.*)\/(Cellar|Caskroom)\/([^/]+)\//);
  const claude = real.match(/^(.*)\/\.local\/share\/claude\/versions\//);
  const candidate = brew
    ? join(brew[1], "bin", name)
    : name === "claude" && claude
      ? join(claude[1], ".local/bin/claude")
      : executable;
  try {
    if (realpathSync(candidate) === real) return candidate;
  } catch {
    /* retain custom path */
  }
  return executable;
}

// Resolve the installation that owns the executable, never the user's current
// npm prefix. Unknown/custom installations must use their own package manager.
export function upgradePlan(name: UpgradeHarness, executable: string) {
  // Muse's launcher checks for and installs updates itself.
  if (name === "muse")
    throw new Error(
      "Muse Code updates itself. Run muse on the computer to check for an update now.",
    );
  if (name === "grok")
    throw new Error(
      "Grok Build updates itself. Run grok update on the computer to check for an update now.",
    );
  if (name === "antigravity")
    throw new Error(
      "Antigravity updates itself. Run agy update on the computer.",
    );
  const real = realpathSync(executable);
  if (name === "opencode" && /loop-opencode|helpers\/opencode/.test(real))
    throw new Error(
      "Managed OpenCode uses Loop’s guarded build. Update Loop and restart the workspace to update this runtime.",
    );
  const brew = real.match(/^(.*)\/(Cellar|Caskroom)\/([^/]+)\//);
  if (brew) {
    const allowed = {
      codex: ["codex"],
      claude: ["claude-code", "claude-code@latest"],
      pi: ["pi"],
      opencode: ["opencode"],
      gemini: ["gemini-cli"],
    };
    if (!allowed[name].includes(brew[3]))
      throw new Error(
        "Upgrade this custom installation with its package manager on the computer.",
      );
    return { command: join(brew[1], "bin/brew"), args: ["upgrade", brew[3]] };
  }
  let dir = dirname(real);
  while (dirname(dir) !== dir) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (pkg.name === packages[name]) {
        const suffix = "/node_modules/" + packages[name];
        if (!dir.endsWith(suffix)) break;
        const base = dir.slice(0, -suffix.length);
        if (base.endsWith("/lib"))
          return {
            command: "npm",
            args: [
              "install",
              "--global",
              "--prefix",
              dirname(base),
              packages[name] + "@latest",
            ],
          };
        // Only Loop's private helper tree may be mutated as a local install.
        if (base.endsWith("/helpers/native"))
          return {
            command: "npm",
            args: [
              "install",
              "--prefix",
              base,
              "--save-exact",
              packages[name] + "@latest",
            ],
          };
        break;
      }
    } catch {
      /* no package at this level */
    }
    dir = dirname(dir);
  }
  if (name === "claude" && /\/\.local\/share\/claude\/versions\//.test(real))
    return { command: executable, args: ["update"] };
  if (name === "opencode") return { command: executable, args: ["upgrade"] };
  throw new Error(
    "Upgrade this custom installation with its package manager on the computer.",
  );
}

// The same installation at an explicit version: npm installs exactly what was
// resolved, and a failed upgrade can reinstall the version it replaced.
function versioned(
  name: UpgradeHarness,
  plan: { command: string; args: string[] },
  version: string,
) {
  if (plan.command === "npm")
    return {
      command: "npm",
      args: [...plan.args.slice(0, -1), packages[name] + "@" + version],
    };
  // Homebrew cannot install a chosen earlier formula or cask version.
  if (plan.args.length !== 1) return undefined;
  if (name === "claude" && plan.args[0] === "update")
    return { command: plan.command, args: ["install", version] };
  if (name === "opencode" && plan.args[0] === "upgrade")
    return { command: plan.command, args: ["upgrade", version] };
  return undefined;
}

export class HarnessUpgrades {
  private records: Record<string, UpgradeRecord> = {};
  private lock?: { name: string; token: object };
  private reconciling = new Set<string>();
  readonly ready: Promise<void>;
  constructor(
    private file: string,
    private run: UpgradeRunner = async (command, args, { env, timeout }) =>
      (
        await exec(command, args, {
          env,
          cwd: dirname(file),
          timeout,
          killSignal: "SIGKILL",
          maxBuffer: 1000000,
        })
      ).stdout,
  ) {
    if (existsSync(file)) this.records = JSON.parse(readFileSync(file, "utf8"));
    // A version probe cannot prove an interrupted installer's children stopped.
    for (const r of Object.values(this.records)) {
      if (r.state === "running" || (r.state as string) === "unknown") {
        r.state = "unconfirmed";
        r.message = `The upgrade was interrupted. It was not retried or rolled back. Stop any remaining installer processes and check the installation on the computer, then confirm recovery in Loop.`;
        this.save();
      }
    }
    const interrupted = Object.values(this.records).filter(
      (r) => r.state === "restart-required",
    );
    for (const record of interrupted) this.reconciling.add(record.name);
    this.ready = this.reconcile(interrupted);
  }
  // Only confirmed installs or explicitly recovered operations awaiting restart
  // can be settled by probing the installation. Never replay an installer.
  private async reconcile(records: UpgradeRecord[]) {
    for (const record of records) {
      const version = record.executable
        ? await this.probe(record.executable, process.env)
        : undefined;
      const reached =
        !!version &&
        (record.target || record.version
          ? compareVersions(version, (record.target || record.version)!) >= 0
          : true);
      record.version = version;
      record.state = reached ? "complete" : "unconfirmed";
      record.message = reached
        ? `The workspace restarted; ${version} is installed. ${READY}`
        : `Loop restarted before the upgrade was confirmed${version ? `; ${version} is installed` : ""}. It was not retried or rolled back. Check the computer for a remaining package-manager process before upgrading again.`;
      this.reconciling.delete(record.name);
    }
    if (records.length) this.save();
  }
  private save() {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = this.file + `.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.records), {
      mode: 0o600,
    });
    const fd = openSync(temporary, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, this.file);
    const directory = openSync(dirname(this.file), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
  private view(record: UpgradeRecord): Upgrade {
    const {
      executable: _executable,
      dismissed: _dismissed,
      restartRequired: _restartRequired,
      ...upgrade
    } = record;
    return upgrade;
  }
  private latest(name: string) {
    return Object.values(this.records)
      .filter((r) => r.name === name)
      .at(-1);
  }
  // Only the harness being upgraded (or confirmed after a restart) is held.
  busy(name: string) {
    const state = this.latest(name)?.state;
    return (
      (!!this.lock && this.lock.name === name) ||
      this.reconciling.has(name) ||
      state === "unconfirmed" ||
      state === "restart-required"
    );
  }
  // Holds a harness before callers check for active runs; run start checks
  // busy() for the same harness, so neither can begin in between. Release is
  // idempotent and never frees a later holder.
  reserve(name: UpgradeHarness) {
    if (this.lock) throw new Error("Another runtime upgrade is in progress.");
    if (this.busy(name))
      throw new Error(
        "This runtime needs recovery or a workspace restart before upgrading again.",
      );
    if (this.reconciling.size)
      throw new Error(
        "Loop is confirming an interrupted upgrade. Try again shortly.",
      );
    const token = {};
    this.lock = { name, token };
    return () => {
      if (this.lock?.token === token) this.lock = undefined;
    };
  }
  operation(name: UpgradeHarness, commandId: string) {
    const previous = this.records[commandId];
    if (previous && previous.name !== name)
      throw new Error("Upgrade identity belongs to another runtime.");
    return previous && this.view(previous);
  }
  availability(name: UpgradeHarness, executable: string) {
    try {
      upgradePlan(name, executable);
      return { canUpgrade: true, upgradeHelp: "" };
    } catch (error) {
      const message = (error as Error).message;
      return {
        canUpgrade: false,
        upgradeHelp:
          message.startsWith("Managed OpenCode") ||
          message.startsWith("Upgrade this custom") ||
          // Self-updating harnesses name their own update command.
          / updates itself\. Run (muse|grok update|agy update) on the computer/.test(
            message,
          )
            ? message
            : "Upgrade this installation on the computer, or rebuild its container image.",
      };
    }
  }
  status(name: UpgradeHarness) {
    const record = this.latest(name);
    return record && !record.dismissed ? this.view(record) : null;
  }
  // Clears a finished outcome from the controls. Its identity is retained, so
  // a repeated request for that operation still returns it rather than rerun.
  dismiss(name: UpgradeHarness) {
    if (this.busy(name))
      throw new Error("Wait for the runtime upgrade to finish.");
    const record = this.latest(name);
    if (record && !record.dismissed) {
      record.dismissed = true;
      this.save();
    }
  }
  // Explicit user recovery acknowledges the stopped installer; identities stay
  // recorded so a reconnect cannot accidentally rerun the original operation.
  recover(name: UpgradeHarness, commandId: string) {
    const record = this.latest(name);
    if (
      this.lock?.name === name ||
      record?.state !== "unconfirmed" ||
      record.commandId !== commandId
    )
      throw new Error("Only an unconfirmed upgrade can be recovered.");
    record.state = record.restartRequired ? "restart-required" : "failed";
    record.message = record.restartRequired
      ? "Recovery confirmed. Restart the workspace to replace the shared Codex app-server before running Codex again."
      : "You confirmed that installer processes have stopped and the installation has been checked. No upgrade or rollback was replayed.";
    if (record.restartRequired) {
      // The user may have restored a previous installation during recovery.
      record.target = record.version = undefined;
    }
    this.save();
  }
  start(
    name: UpgradeHarness,
    executable: string,
    commandId: string,
    env: NodeJS.ProcessEnv = process.env,
    options: { restartRequired?: boolean } = {},
  ) {
    const previous = this.operation(name, commandId);
    if (previous) return previous;
    const release = this.reserve(name);
    let record: UpgradeRecord, plan: { command: string; args: string[] };
    try {
      executable = resolve(upgradeLauncher(name, executable));
      plan = upgradePlan(name, executable);
      record = {
        commandId,
        name,
        state: "running",
        message: "Upgrading runtime…",
        executable,
        restartRequired: options.restartRequired,
      };
      this.records[commandId] = record;
      this.save();
    } catch (error) {
      release();
      throw error;
    }
    // Never return raw installer output: it can contain configuration or tokens.
    void this.perform(record, plan, env)
      .catch(() => {
        record.state = "unconfirmed";
        record.message =
          "Upgrade could not be confirmed. Stop remaining installer processes and check the installation on the computer, then confirm recovery in Loop.";
      })
      .finally(() => {
        release();
        this.save();
      });
    return this.view(record);
  }
  private async probe(executable: string, env: NodeJS.ProcessEnv) {
    try {
      const stdout = await this.run(executable, ["--version"], {
        env,
        timeout: 10000,
      });
      return stdout.match(/\b\d+\.\d+\.\d+(?:-[\w.]+)?\b/)?.[0];
    } catch {
      return undefined;
    }
  }
  private async perform(
    record: UpgradeRecord,
    plan: { command: string; args: string[] },
    env: NodeJS.ProcessEnv,
  ) {
    const executable = record.executable!;
    const installEnv = { ...env, CI: "1", npm_config_yes: "true" };
    record.previous = await this.probe(executable, env);
    let install = plan;
    if (plan.command === "npm") {
      // Resolve the target first so the result can be verified exactly.
      const latest = await this.run(
        "npm",
        ["view", packages[record.name] + "@latest", "version"],
        { env: installEnv, timeout: 60000 },
      ).catch(() => "");
      record.target = latest.trim();
      if (!exact(record.target)) {
        record.target = undefined;
        record.state = "failed";
        record.message = `Loop could not resolve the latest release, so nothing was changed. ${CHECK}`;
        return;
      }
      install = versioned(record.name, plan, record.target)!;
    }
    this.save();
    let failure = "";
    try {
      await this.run(install.command, install.args, {
        env: installEnv,
        timeout: 600000,
      });
    } catch (error) {
      if (
        (error as { killed?: boolean; signal?: string })?.killed ||
        (error as { signal?: string })?.signal
      ) {
        record.state = "unconfirmed";
        record.message =
          "The installer was interrupted. Its child processes may still be running, so no rollback was started. Stop remaining installer processes and check the installation on the computer, then confirm recovery in Loop.";
        return;
      }
      failure = "the installer reported an error";
    }
    const version = await this.probe(executable, env);
    record.version = version;
    if (!failure) {
      if (!version) failure = "the installed version could not be read";
      else if (record.target && compareVersions(version, record.target) < 0)
        failure = `${version} is installed instead of ${record.target}`;
      else if (record.previous && compareVersions(version, record.previous) < 0)
        failure = `${version} is older than the previous ${record.previous}`;
    }
    if (!failure) {
      record.state = record.restartRequired ? "restart-required" : "complete";
      record.message =
        version === record.previous
          ? `Already up to date: ${version} is installed.`
          : `Upgraded ${record.previous ? `from ${record.previous} ` : ""}to ${version}. ${READY}`;
      if (record.restartRequired)
        record.message = `${version} is installed. Restart the workspace to replace the shared Codex app-server before running Codex again. Queued prompts will wait.`;
      return;
    }
    record.state = "failed";
    record.message = `Upgrade failed: ${failure}. ${await this.rollback(record, plan, installEnv)}`;
  }
  // One attempt to restore the replaced version; its outcome is reported as
  // observed and never retried.
  private async rollback(
    record: UpgradeRecord,
    plan: { command: string; args: string[] },
    env: NodeJS.ProcessEnv,
  ) {
    const previous = record.previous;
    if (!previous)
      return `The previous version could not be read, so it was not reinstalled. ${CHECK}`;
    if (record.version === previous) return `${previous} remains installed.`;
    const back = versioned(record.name, plan, previous);
    if (!back)
      return `Homebrew cannot reinstall ${previous} automatically. ${CHECK}`;
    try {
      await this.run(back.command, back.args, { env, timeout: 600000 });
    } catch (error) {
      if (
        (error as { killed?: boolean; signal?: string })?.killed ||
        (error as { signal?: string })?.signal
      ) {
        record.state = "unconfirmed";
        return "Rollback was interrupted and may have surviving installer processes. Stop them and check the installation on the computer, then confirm recovery in Loop.";
      }
    }
    const version = await this.probe(record.executable!, env);
    record.version = version;
    return version === previous
      ? `Rolled back to ${previous}.`
      : `Rollback to ${previous} failed; ${version ? `${version} is installed` : "the installed version could not be read"}. ${CHECK}`;
  }
}
