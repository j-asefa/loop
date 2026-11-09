import { shellWords } from "./pr-command.js";

/**
 * Which commands count as verification: tests, type checks and lints that
 * developers run on the code they touched. Loop records the ones an agent
 * ran and the exit it saw; it never runs them itself. The classifier is
 * conservative: only literal commands it recognises, never expansions.
 */
type VerificationKind = "test" | "typecheck" | "lint";
export type VerificationStatus = "passed" | "failed" | "unknown";
export type VerificationItem = {
  id: string;
  kind: VerificationKind;
  tools: string[];
  command: string;
  status: VerificationStatus;
  exit_code: number | null;
  truncated: boolean;
  observed_at: number;
};
export type VerificationSummary = {
  passed: number;
  failed: number;
  unknown: number;
  items: Pick<VerificationItem, "id" | "kind" | "tools" | "status">[];
};

type Classified = { kind: VerificationKind; tool: string };
const TEST_TOOLS = new Set([
  "vitest",
  "jest",
  "mocha",
  "ava",
  "tap",
  "pytest",
  "rspec",
  "phpunit",
  "tox",
  "nox",
]);
const TYPECHECK_TOOLS = new Set(["tsc", "mypy", "pyright"]);
const LINT_TOOLS = new Set([
  "eslint",
  "ruff",
  "flake8",
  "pylint",
  "biome",
  "stylelint",
  "golangci-lint",
  "rubocop",
]);
const SCRIPT_KINDS: [RegExp, VerificationKind][] = [
  [/^(?:test|tests|e2e|spec|specs|vitest|jest)(?::|$)/, "test"],
  [/^(?:typecheck|type-check|types|check-types|tsc)(?::|$)/, "typecheck"],
  [/^(?:lint|eslint|check|format:check|prettier:check)(?::|$)/, "lint"],
];

function strip(path: string) {
  return path.replace(/^.*\//, "");
}
// Arguments under which a recognised tool checks nothing.
const NO_RUN = new Set([
  "--help",
  "-h",
  "--version",
  "-V",
  "--showConfig",
  "--print-config",
  "--listTests",
  "--list-tests",
  "--collect-only",
  "--dry-run",
  "install",
  "init",
  "--init",
  "login",
  "config",
  "--if-present",
]);
// Shell builtins that end or replace the shell: a chain containing one
// cannot be read as "every step ran".
const TERMINATING = new Set([
  "exit",
  "return",
  "exec",
  "eval",
  "source",
  ".",
  "trap",
]);
/** Classify one simple command (no chains), or null when it is not verification. */
function classifySegment(tokens: string[]): Classified | null {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  const argv = tokens.slice(i);
  if (!argv.length) return null;
  if (argv.slice(1).some((a) => NO_RUN.has(a))) return null;
  const tool = strip(argv[0]);
  const sub = argv[1] ?? "";
  const has = (flag: string) => argv.slice(1).includes(flag);
  if (tool === "pnpm" && sub === "dlx") return classifySegment(argv.slice(2));
  if (tool === "yarn" && sub === "dlx") return classifySegment(argv.slice(2));
  if (["npm", "pnpm", "yarn", "bun"].includes(tool)) {
    const script =
      sub === "run" || sub === "run-script" ? (argv[2] ?? "") : sub;
    if (script === "test" || script === "t")
      return { kind: "test", tool: `${tool} test` };
    if (
      sub === "run" ||
      sub === "run-script" ||
      tool === "yarn" ||
      tool === "bun"
    ) {
      for (const [pattern, kind] of SCRIPT_KINDS)
        if (pattern.test(script))
          return { kind, tool: `${tool} run ${script}` };
    }
    return null;
  }
  if (["npx", "pnpx", "bunx"].includes(tool)) {
    let j = 1;
    while (
      j < argv.length &&
      /^-/.test(argv[j]) &&
      !["-p", "--package", "-c", "--call"].includes(argv[j])
    )
      j++;
    return classifySegment(argv.slice(j));
  }
  if (TEST_TOOLS.has(tool)) return { kind: "test", tool };
  if (tool === "playwright" && sub === "test")
    return { kind: "test", tool: "playwright test" };
  if (tool === "cypress" && sub === "run")
    return { kind: "test", tool: "cypress run" };
  if (TYPECHECK_TOOLS.has(tool)) return { kind: "typecheck", tool };
  if (LINT_TOOLS.has(tool)) return { kind: "lint", tool };
  if (tool === "node" && has("--test"))
    return { kind: "test", tool: "node --test" };
  if (tool === "deno" && ["test", "lint", "check"].includes(sub))
    return {
      kind: sub === "test" ? "test" : sub === "lint" ? "lint" : "typecheck",
      tool: `deno ${sub}`,
    };
  if (["python", "python3"].includes(tool) && sub === "-m") {
    const module = argv[2] ?? "";
    if (["pytest", "unittest"].includes(module))
      return { kind: "test", tool: module };
    if (module === "mypy") return { kind: "typecheck", tool: "mypy" };
    if (["ruff", "flake8", "pylint"].includes(module))
      return { kind: "lint", tool: module };
    return null;
  }
  // go test -c only compiles the test binary.
  if (tool === "go" && sub === "test")
    return has("-c") ? null : { kind: "test", tool: "go test" };
  if (tool === "go" && sub === "vet") return { kind: "lint", tool: "go vet" };
  if (tool === "cargo" && sub === "test")
    return has("--no-run") ? null : { kind: "test", tool: "cargo test" };
  if (tool === "cargo" && sub === "check")
    return { kind: "typecheck", tool: "cargo check" };
  if (tool === "cargo" && sub === "clippy")
    return { kind: "lint", tool: "cargo clippy" };
  if (tool === "bundle" && sub === "exec")
    return classifySegment(argv.slice(2));
  if (["rake", "make"].includes(tool)) {
    // make -n, -q and their long forms print or question without running.
    if (
      argv
        .slice(1)
        .some(
          (a) =>
            /^-[a-zA-Z]*[nq]/.test(a) ||
            ["--dry-run", "--just-print", "--recon", "--question"].includes(a),
        )
    )
      return null;
    for (const target of argv.slice(1)) {
      for (const [pattern, kind] of SCRIPT_KINDS)
        if (pattern.test(target)) return { kind, tool: `${tool} ${target}` };
    }
    return null;
  }
  if (["mvn", "gradle", "gradlew"].includes(tool)) {
    if (argv.slice(1).some((a) => ["test", "verify", "check"].includes(a)))
      return { kind: "test", tool: `${tool} test` };
    return null;
  }
  if (tool === "dotnet" && sub === "test")
    return { kind: "test", tool: "dotnet test" };
  if (tool === "swift" && sub === "test")
    return { kind: "test", tool: "swift test" };
  if (tool === "prettier" && has("--check"))
    return { kind: "lint", tool: "prettier --check" };
  return null;
}

/**
 * The verification tools a command runs, in order, or an empty list when
 * none of its parts is verification. Only literal `&&` chains are read;
 * a leading `cd` and environment assignments are skipped. The chain's exit
 * is the chain's: zero means every part exited zero.
 */
/** Longer than any verification command; a command this long may have been cut. */
const COMMAND_LIMIT = 2000;
export function classifyVerification(command: string): Classified[] {
  if (command.length > COMMAND_LIMIT) return [];
  let tokens = shellWords(command, { strict: true });
  if (!tokens) return [];
  if (
    tokens.length === 3 &&
    /^(?:\/bin\/)?(?:bash|sh|zsh)$/.test(tokens[0] || "") &&
    /^-[eilx]*c$/.test(tokens[1] || "")
  )
    tokens = shellWords(tokens[2] || "", { strict: true });
  if (!tokens?.length) return [];
  const segments: string[][] = [[]];
  for (const token of tokens) {
    if (token === null) segments.push([]);
    else segments.at(-1)!.push(token);
  }
  // The command word of a segment, past any environment assignments.
  const head = (segment: string[]) => {
    let i = 0;
    while (i < segment.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[i]))
      i++;
    // "builtin exit", "command exit": the wrapper names the real command.
    while (
      ["builtin", "command"].includes(segment[i] ?? "") &&
      i + 1 < segment.length
    )
      i++;
    return strip(segment[i] ?? "");
  };
  const noExec = (segment: string[]) => {
    if (head(segment) !== "set") return false;
    const args = segment.slice(
      segment.indexOf(segment.find((t) => strip(t) === "set")!) + 1,
    );
    return args.some(
      (a, k) =>
        /^-[a-zA-Z]*n/.test(a) || (a === "-o" && args[k + 1] === "noexec"),
    );
  };
  if (
    segments.some(
      (segment) => TERMINATING.has(head(segment)) || noExec(segment),
    )
  )
    return [];
  const found: Classified[] = [];
  for (const segment of segments) {
    if (!segment.length || head(segment) === "cd") continue;
    const classified = classifySegment(segment);
    if (classified) found.push(classified);
  }
  return found;
}

/** How many commands a literal chain runs, counting a leading cd. */
export function chainLength(command: string) {
  let tokens = shellWords(command, { strict: true });
  if (!tokens) return 0;
  if (
    tokens.length === 3 &&
    /^(?:\/bin\/)?(?:bash|sh|zsh)$/.test(tokens[0] || "") &&
    /^-[eilx]*c$/.test(tokens[1] || "")
  )
    tokens = shellWords(tokens[2] || "", { strict: true });
  if (!tokens?.length) return 0;
  return tokens.filter((t) => t === null).length + 1;
}

export function summarize(items: VerificationItem[]): VerificationSummary {
  return {
    passed: items.filter((i) => i.status === "passed").length,
    failed: items.filter((i) => i.status === "failed").length,
    unknown: items.filter((i) => i.status === "unknown").length,
    items: items.map(({ id, kind, tools, status }) => ({
      id,
      kind,
      tools,
      status,
    })),
  };
}
