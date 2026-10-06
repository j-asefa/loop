/** Pi customization operations executed beside the managed Pi binary. */
import { spawn } from "node:child_process";
import {
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
  renameSync,
  mkdirSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  piInstructionSources,
  piPackageEntries,
  piProjectResources,
  piSavedTrust,
  piSettingsPath,
  settingsHash,
  updatePiPackageFilters,
} from "../server/pi-customization-files.js";
import {
  inspectPiPackage,
  previousPiPackageSource,
} from "../server/pi-package-inspect.js";
import { expandPiPrompt, piPromptBody } from "../server/pi-prompt-preview.js";
import { runPi } from "../server/pi-run.js";

type Scope = "user" | "project";
type Input = Record<string, any>;
let busy = false;

export async function piCustomization(
  input: Input,
  context: {
    project: string;
    agentDir: string;
    executable: string;
    environment: NodeJS.ProcessEnv;
  },
) {
  const { project, agentDir, executable, environment } = context;
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const trustPath = join(agentDir, "trust.json");
  const fingerprintPath = join(agentDir, "loop-trust-fingerprints.json");
  const writeJson = (path: string, value: unknown) => {
    const temp = path + `.tmp-${process.pid}`;
    writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
    renameSync(temp, path);
  };
  const readJson = (path: string): Record<string, any> => {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return {};
    }
  };
  const guardTrust = () => {
    const pinned = readJson(fingerprintPath)[project];
    if (pinned && pinned !== piProjectResources(project).fingerprint) {
      const entries = readJson(trustPath);
      entries[project] = false;
      writeJson(trustPath, entries);
      const fingerprints = readJson(fingerprintPath);
      delete fingerprints[project];
      writeJson(fingerprintPath, fingerprints);
    }
  };
  guardTrust();
  const trust = () => {
    const resources = piProjectResources(project);
    const saved = piSavedTrust(agentDir, project);
    return {
      ...resources,
      trusted: !resources.required || saved?.trusted === true,
      decision: resources.required
        ? saved?.decision || "undecided"
        : "not required",
    };
  };
  const recoveryPath = join(agentDir, "loop-package-recovery.json");
  const recovery = (): Record<string, string> => readJson(recoveryPath);
  const recoveryKey = (scope: Scope, source: string) =>
    `${project}\0${scope}\0${source}`;
  const saveRecovery = (value: Record<string, string>) => {
    writeJson(recoveryPath, value);
  };
  const configuration = () => {
    const pins = recovery();
    return {
      project,
      trust: trust(),
      packages: piPackageEntries(agentDir, project).map((entry) => ({
        ...entry,
        settingsHash: settingsHash(
          piSettingsPath(agentDir, project, entry.scope),
        ),
        previousSource: pins[recoveryKey(entry.scope, entry.source)],
        resolvedSource: (() => {
          try {
            return previousPiPackageSource(
              entry.source,
              entry.scope,
              agentDir,
              project,
            );
          } catch {
            return undefined;
          }
        })(),
      })),
      instructions: piInstructionSources(agentDir, project, trust().trusted),
    };
  };
  if (input.action === "configuration") return configuration();
  if (input.action === "guard-trust") return { trust: trust() };
  if (input.action === "catalog") {
    const child = spawn(executable, ["--mode", "rpc", "--no-session"], {
      cwd: project,
      env: environment,
      stdio: ["pipe", "pipe", "ignore"],
    });
    try {
      const replies = new Map<string, any>();
      const result = await new Promise<any>((resolveReply, rejectReply) => {
        const timer = setTimeout(
          () => rejectReply(new Error("Pi catalog timed out")),
          25000,
        );
        let buffer = "";
        const finish = (error?: Error) => {
          clearTimeout(timer);
          if (error) rejectReply(error);
          else
            resolveReply({
              commands: replies.get("commands")?.commands || [],
              state: replies.get("state"),
            });
        };
        child.on("error", finish);
        child.on("exit", () => finish(new Error("Pi catalog process exited")));
        child.stdout.on("data", (chunk) => {
          buffer += chunk.toString();
          if (buffer.length > 4_000_000)
            return finish(new Error("Pi catalog too large"));
          let end: number;
          while ((end = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            try {
              const frame = JSON.parse(line);
              if (frame.id === "commands" || frame.id === "state") {
                if (frame.success === false)
                  return finish(new Error("Pi catalog request failed"));
                replies.set(frame.id, frame.data);
                if (replies.size === 2) return finish();
              }
            } catch {
              /* Pi events are not catalog replies. */
            }
          }
        });
        child.stdin.write(
          JSON.stringify({ id: "commands", type: "get_commands" }) + "\n",
        );
        child.stdin.write(
          JSON.stringify({ id: "state", type: "get_state" }) + "\n",
        );
      });
      return result;
    } finally {
      child.kill("SIGTERM");
    }
  }
  if (input.action === "trust") {
    const current = piProjectResources(project);
    if (current.fingerprint !== input.fingerprint)
      throw new Error("Project resources changed. Review them again.");
    const entries = readJson(trustPath);
    entries[project] = input.trusted === true;
    writeJson(trustPath, entries);
    const fingerprints = readJson(fingerprintPath);
    if (input.trusted) fingerprints[project] = current.fingerprint;
    else delete fingerprints[project];
    writeJson(fingerprintPath, fingerprints);
    return configuration();
  }
  if (input.action === "inspect")
    return inspectPiPackage(input.source, project);
  if (input.action === "preview") {
    const path = realpathSync(input.path);
    const allowed = [realpathSync(agentDir) + sep, realpathSync(project) + sep];
    if (
      !allowed.some((prefix) => path.startsWith(prefix)) ||
      !path.endsWith(".md") ||
      !statSync(path).isFile() ||
      statSync(path).size > 100_000
    )
      throw new Error("Loaded prompt file is unavailable");
    return {
      token: `/${input.name}${input.args ? ` ${input.args}` : ""}`,
      expanded: expandPiPrompt(
        piPromptBody(readFileSync(path, "utf8")),
        input.args,
      ),
    };
  }
  if (busy) throw new Error("A Pi package change is already running");
  if (
    input.action === "filters" ||
    input.action === "package" ||
    input.action === "rollback"
  ) {
    const scope: Scope = input.scope;
    const source: string = input.source;
    if (
      !source ||
      source.length > 512 ||
      source.startsWith("-") ||
      /[\x00-\x1f]/.test(source)
    )
      throw new Error("Invalid Pi package source");
    if (scope === "project" && !trust().trusted)
      throw new Error(
        "Review and trust this project before changing project packages",
      );
    const entries = piPackageEntries(agentDir, project);
    const present = entries.some(
      (entry) => entry.scope === scope && entry.source === source,
    );
    if (input.action !== "package" || input.operation !== "install") {
      if (!present)
        throw new Error("Package is no longer configured. Refresh and retry.");
    }
    busy = true;
    try {
      if (input.action === "filters") {
        updatePiPackageFilters(
          piSettingsPath(agentDir, project, scope),
          source,
          input.filters,
          input.settingsHash,
        );
      } else {
        const pins = recovery();
        const key = recoveryKey(scope, source);
        let previous: string | undefined;
        if (input.action === "rollback") {
          previous = pins[key];
          if (!previous) throw new Error("No recovery revision is available");
        } else if (input.operation === "update") {
          try {
            previous = previousPiPackageSource(
              source,
              scope,
              agentDir,
              project,
            );
          } catch {
            /* No resolved revision to pin. */
          }
        }
        if (
          input.action === "package" &&
          input.operation === "update" &&
          entries.some(
            (entry) => entry.scope !== scope && entry.source === source,
          )
        )
          throw new Error(
            "Pi updates matching sources in both scopes. Remove the duplicate first.",
          );
        if (source.startsWith("./")) {
          const canonicalProject = realpathSync(project);
          const path = realpathSync(resolve(canonicalProject, ".pi", source));
          if (
            scope !== "project" ||
            !path.startsWith(canonicalProject + sep) ||
            !statSync(path).isDirectory()
          )
            throw new Error(
              "Local packages must be directories inside this project",
            );
        } else if (!/^(npm:|git:)/.test(source) && !present) {
          throw new Error("Use an npm: or git: source, or a ./ project path");
        }
        const operation =
          input.action === "rollback" ? "install" : input.operation;
        await runPi(
          executable,
          [
            operation,
            input.action === "rollback" ? previous! : source,
            ...(operation !== "update" && scope === "project"
              ? ["--local"]
              : []),
            scope === "project" ? "--approve" : "--no-approve",
          ],
          { cwd: project, env: environment },
        );
        if (input.action === "rollback" || operation === "remove")
          delete pins[key];
        else if (operation === "update" && previous) {
          const current = previousPiPackageSource(
            source,
            scope,
            agentDir,
            project,
          );
          if (current && current !== previous) pins[key] = previous;
        }
        saveRecovery(pins);
      }
      if (scope === "project" && trust().trusted) {
        const fingerprints = readJson(fingerprintPath);
        fingerprints[project] = piProjectResources(project).fingerprint;
        writeJson(fingerprintPath, fingerprints);
      }
      return {
        status: "configured",
        application: "new-session",
        ...configuration(),
      };
    } finally {
      busy = false;
    }
  }
  throw new Error("Unknown Pi customization action");
}
