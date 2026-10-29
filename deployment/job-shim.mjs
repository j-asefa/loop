// Used only in native harness PATHs. A shell keeps ordinary commands' PID and
// protocol descriptors intact; JavaScript handles known finite checks only.
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, resolve, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
  insideQueuedJob,
  queueConfiguration,
  runQueuedJob,
} from "./job-client.mjs";

function packageAt(directory) {
  try {
    return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
}
function loopProject(cwd) {
  for (let dir = cwd; ; dir = dirname(dir)) {
    const pkg = packageAt(dir);
    const repository =
      typeof pkg?.repository === "string"
        ? pkg.repository
        : pkg?.repository?.url;
    if (pkg?.name === "loop" && /j-asefa\/loop/.test(repository || ""))
      return dir;
    if (dir === dirname(dir)) return undefined;
  }
}
function queueAware(root) {
  if (!root) return false;
  try {
    return readFileSync(
      join(root, "scripts/heavy-command.mjs"),
      "utf8",
    ).includes("runQueuedJob");
  } catch {
    return false;
  }
}
function nodeScript(args) {
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (
      ["-e", "--eval", "-p", "--print"].includes(value) ||
      /^(--eval|--print)=/.test(value) ||
      /^-[ep]./.test(value)
    )
      return undefined;
    if (
      [
        "--import",
        "--require",
        "-r",
        "--loader",
        "--experimental-loader",
        "--env-file",
        "--env-file-if-exists",
        "--conditions",
        "-C",
        "--test-reporter",
        "--test-reporter-destination",
        "--test-name-pattern",
        "--test-skip-pattern",
        "--test-concurrency",
        "--test-timeout",
        "--test-shard",
        "--test-isolation",
        "--test-global-setup",
        "--test-rerun-failures",
        "--test-coverage-include",
        "--test-coverage-exclude",
        "--test-coverage-lines",
        "--test-coverage-functions",
        "--test-coverage-branches",
        "--watch-path",
        "--input-type",
        "--inspect-port",
        "--diagnostic-dir",
        "--redirect-warnings",
        "--title",
        "--max-old-space-size",
        "--max-semi-space-size",
        "--stack-trace-limit",
        "--unhandled-rejections",
        "--allow-fs-read",
        "--allow-fs-write",
        "--build-snapshot-config",
        "--cpu-prof-dir",
        "--cpu-prof-interval",
        "--cpu-prof-name",
        "--disable-proto",
        "--disable-warning",
        "--dns-result-order",
        "--experimental-package-map",
        "--experimental-sea-config",
        "--experimental-test-tag-filter",
        "--heap-prof-dir",
        "--heap-prof-interval",
        "--heap-prof-name",
        "--heapsnapshot-near-heap-limit",
        "--heapsnapshot-signal",
        "--icu-data-dir",
        "--inspect-publish-uid",
        "--localstorage-file",
        "--max-http-header-size",
        "--max-old-space-size-percentage",
        "--network-family-autoselection-attempt-timeout",
        "--openssl-config",
        "--report-dir",
        "--report-directory",
        "--report-filename",
        "--report-signal",
        "--secure-heap",
        "--secure-heap-min",
        "--snapshot-blob",
        "--test-random-seed",
        "--tls-cipher-list",
        "--tls-keylog",
        "--trace-event-categories",
        "--trace-event-file-pattern",
        "--trace-require-module",
        "--use-largepages",
        "--v8-pool-size",
        "--watch-kill-signal",
      ].includes(value)
    ) {
      i++;
      continue;
    }
    if (value === "--") return i + 1 < args.length ? i + 1 : undefined;
    if (!value.startsWith("-")) return i;
  }
}
function toolWords(args, program) {
  const values = new Set(
    program === "npm"
      ? [
          "--prefix",
          "--workspace",
          "-w",
          "--userconfig",
          "--cache",
          "--registry",
          "--loglevel",
          "--tag",
          "--package",
          "-p",
        ]
      : ["--package", "-p", "--cache", "--userconfig", "--registry"],
  );
  const words = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--") return [...words, ...args.slice(i + 1)];
    if (values.has(args[i])) {
      i++;
      continue;
    }
    if (!args[i].startsWith("-")) words.push(args[i]);
  }
  return words;
}
function compiler7(path) {
  try {
    for (let dir = dirname(realpathSync(path)); ; dir = dirname(dir)) {
      const pkg = packageAt(dir);
      if (pkg?.name === "typescript")
        return Number(pkg.version.split(".")[0]) >= 7;
      if (dir === dirname(dir)) return false;
    }
  } catch {
    return false;
  }
}

export function classifyCommand(program, original, cwd = process.cwd()) {
  const args = [...original];
  const root = loopProject(cwd),
    aware = queueAware(root);
  let label,
    compiler = false;
  if (program === "node") {
    const index = nodeScript(args);
    const script = index === undefined ? "" : args[index];
    const name = basename(script);
    if (["tsc", "tsc.js", "_tsc.js"].includes(name)) {
      label = "typecheck";
      compiler = compiler7(resolve(cwd, script));
      if (
        compiler &&
        !args.some(
          (a) => a === "--singleThreaded" || a.startsWith("--singleThreaded="),
        )
      )
        args.push("--singleThreaded");
    } else if (
      args.slice(0, index ?? args.length).includes("--test") &&
      !args.some((a) => /^(--eval|--print)(=|$)|^-[ep]/.test(a))
    )
      label = "native tests";
    else if (/^(vitest|vite-node)(\.m?js)?$/.test(name)) {
      if (
        name.startsWith("vite-node") ||
        args
          .slice(index + 1)
          .some((a) => ["run", "--run", "--watch=false"].includes(a))
      )
        label = "tests";
    } else if (
      root &&
      dirname(resolve(cwd, script)) === join(root, "scripts")
    ) {
      const managed = [
        "typecheck.mjs",
        "build.mjs",
        "check.mjs",
        "test-runner.mjs",
        "heavy-command.mjs",
        "design-browser-smoke.mjs",
      ];
      if (managed.includes(name)) {
        if (!aware) label = name.replace(/\.mjs$/, "");
      } else if (name === "design-scenario.mjs" || /browser.*\.mjs$/.test(name))
        label = "browser check";
    }
  } else if (program === "npm") {
    // Unknown flags stay conservatively queued; never assume --prefix selects
    // the package we inspected in the current directory.
    const words = toolWords(args, program);
    const verb = words[0],
      script = verb === "test" || verb === "t" ? "test" : words[1];
    if (
      ["run", "run-script", "test", "t"].includes(verb) &&
      /^(test($|:)|typecheck$|check$|build($|:)|smoke:)/.test(script || "")
    ) {
      const known =
        [
          "build",
          "check",
          "typecheck",
          "test",
          "test:native",
          "test:all",
        ].includes(script) ||
        script?.startsWith("smoke:") ||
        script === "test:browser:acp";
      if (
        !aware ||
        !known ||
        args[0]?.startsWith("-") ||
        args.some((arg) =>
          /^(--prefix|--workspace|--workspaces)(=|$)|^-w/.test(arg),
        )
      )
        label = script;
    } else if (["ci", "install", "i", "add", "rebuild"].includes(verb))
      label = "dependency installation";
    else if (["exec", "x"].includes(verb))
      label = classifyCommand(
        "npx",
        args.slice(args.indexOf(verb) + 1),
        cwd,
      ).label;
  } else if (program === "npx") {
    const [tool, ...words] = toolWords(args, program);
    if (
      tool === "tsc" ||
      (tool === "playwright" && words[0] === "test") ||
      (tool === "vite" && words[0] === "build") ||
      (tool === "vitest" &&
        args.some((a) => ["run", "--run", "--watch=false"].includes(a)))
    )
      label = tool + " check";
  }
  // Watchers and development servers never release a finite queue slot. For
  // npm, -w selects a workspace; only arguments after -- belong to its script.
  const checkArgs =
    program === "npm"
      ? args.slice(
          args.indexOf("--") < 0 ? args.length : args.indexOf("--") + 1,
        )
      : args;
  if (
    checkArgs.some(
      (a) =>
        (/^(--watch|--watch-path|--ui)(=|$)/.test(a) &&
          !a.endsWith("=false")) ||
        a === "-w",
    )
  )
    label = undefined;
  // Version/help probes must stay fast and must not create queue jobs.
  if (args.some((a) => ["--version", "-v", "--help", "-h"].includes(a)))
    label = undefined;
  return { label, args, compiler };
}

export function shimScript(configPath, node, shim, program, command) {
  const shell = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const invoke = [node, shim].map(shell).join(" ");
  // Node execve closes descriptors above stderr. Classify in a subprocess;
  // the shell must exec native harnesses and their protocol FDs directly.
  return (
    "#!/bin/sh\nexport LOOP_JOB_QUEUE_CONFIG=" +
    shell(configPath) +
    "\n" +
    invoke +
    " --needs-wrapper " +
    shell(program) +
    ' "$@"\ncase $? in\n' +
    "  0) exec " +
    invoke +
    " " +
    shell(program) +
    ' "$@" ;;\n' +
    "  1) exec " +
    shell(command) +
    ' "$@" ;;\n' +
    "  *) echo 'Loop command queue configuration is unavailable; command not started.' >&2; exit 125 ;;\nesac\n"
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const probe = process.argv[2] === "--needs-wrapper";
  const [program, ...input] = process.argv.slice(probe ? 3 : 2);
  try {
    const { label, args, compiler } = classifyCommand(program, input);
    if (probe && !label && !compiler) process.exit(1);
    const config = await queueConfiguration();
    const command = config.commands?.[program];
    if (typeof command !== "string" || !isAbsolute(command))
      throw new Error("Missing underlying executable.");
    if (probe)
      process.exit(compiler || (label && !insideQueuedJob(config)) ? 0 : 1);
    const env = compiler
      ? { ...process.env, GOMEMLIMIT: process.env.GOMEMLIMIT || "1536MiB" }
      : process.env;
    if (label && !insideQueuedJob(config))
      process.exitCode = await runQueuedJob(command, args, { label, env });
    else process.execve(command, [command, ...args], env);
  } catch {
    console.error(
      "Loop could not start this command through its job queue. Check loop-job status; the command was not replayed.",
    );
    process.exitCode = probe ? 2 : 125;
  }
}
