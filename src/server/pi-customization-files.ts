import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { dirname, join } from "node:path";

export type PiScope = "user" | "project";
export type PiPackageEntry = {
  source: string;
  scope: PiScope;
  autoload?: boolean;
  filters: Partial<
    Record<"extensions" | "skills" | "prompts" | "themes", string[]>
  >;
};
export const resourceKinds = [
  "extensions",
  "skills",
  "prompts",
  "themes",
] as const;
const protectedEntries = [
  "settings.json",
  ...resourceKinds,
  "SYSTEM.md",
  "APPEND_SYSTEM.md",
];

export function piSettingsPath(
  agentDir: string,
  project: string,
  scope: PiScope,
) {
  return scope === "user"
    ? join(agentDir, "settings.json")
    : join(project, ".pi", "settings.json");
}

export function readPiSettings(path: string): Record<string, any> {
  if (!existsSync(path)) return {};
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid Pi settings file: ${path}`);
  return value;
}

export function piPackageEntries(
  agentDir: string,
  project: string,
): PiPackageEntry[] {
  return (["user", "project"] as const).flatMap((scope) => {
    const settings = readPiSettings(piSettingsPath(agentDir, project, scope));
    return (Array.isArray(settings.packages) ? settings.packages : []).flatMap(
      (item: any) => {
        const source = typeof item === "string" ? item : item?.source;
        if (typeof source !== "string") return [];
        const filters: PiPackageEntry["filters"] = {};
        for (const kind of resourceKinds)
          if (Array.isArray(item?.[kind]))
            filters[kind] = item[kind].filter(
              (x: unknown) => typeof x === "string",
            );
        return [{
          source,
          scope,
          ...(typeof item?.autoload === "boolean"
            ? { autoload: item.autoload }
            : {}),
          filters,
        }];
      },
    );
  });
}

// Bounds for walking trust-gated resources, which may include an extension's
// own node_modules.
const FINGERPRINT_DEPTH = 16;
const FINGERPRINT_ENTRIES = 20_000;

/**
 * Adds a resource and everything below it to the fingerprint: each entry's
 * relative path, type, size and modification time, following symlinks (their
 * targets count too). Editing or adding any file then changes the
 * fingerprint, so Loop asks for trust again. File contents are not read.
 */
function fingerprintTree(
  hash: ReturnType<typeof createHash>,
  root: string,
  budget: { entries: number },
) {
  const seen = new Set<string>();
  const visit = (path: string, rel: string, depth: number) => {
    if (--budget.entries < 0) return;
    let link = "";
    let info;
    try {
      if (lstatSync(path).isSymbolicLink()) link = readlinkSync(path);
      info = statSync(path);
    } catch {
      hash.update(`${rel}\0missing\0${link}\n`);
      return;
    }
    const kind = info.isDirectory() ? "d" : info.isFile() ? "f" : "o";
    hash.update(`${rel}\0${kind}\0${info.size}\0${info.mtimeMs}\0${link}\n`);
    if (kind !== "d" || depth >= FINGERPRINT_DEPTH) return;
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      return;
    }
    // A symlink loop is fingerprinted once.
    if (seen.has(real)) return;
    seen.add(real);
    let names: string[];
    try {
      names = readdirSync(path).sort();
    } catch {
      hash.update(`${rel}\0unreadable\n`);
      return;
    }
    for (const name of names) visit(join(path, name), rel + "/" + name, depth + 1);
  };
  visit(root, ".", 0);
}

/** Reviewable, bounded snapshot of trust-gated project resources. */
export function piProjectResources(project: string) {
  const paths: { path: string; kind: "file" | "directory"; size?: number }[] =
    [];
  const add = (path: string) => {
    if (!existsSync(path) && !lstatSync(path, { throwIfNoEntry: false }))
      return;
    // A symlinked resource is what it points at.
    let info;
    try {
      info = statSync(path);
    } catch {
      info = lstatSync(path);
    }
    paths.push({
      path,
      kind: info.isDirectory() ? "directory" : "file",
      size: info.isFile() ? info.size : undefined,
    });
  };
  for (const name of protectedEntries) add(join(project, ".pi", name));
  for (let dir = project; ; dir = dirname(dir)) {
    const candidate = join(dir, ".agents", "skills");
    if (candidate !== join(process.env.HOME || "", ".agents", "skills"))
      add(candidate);
    if (dirname(dir) === dir) break;
  }
  const fingerprint = createHash("sha256");
  const budget = { entries: FINGERPRINT_ENTRIES };
  for (const item of paths) {
    fingerprint.update(item.path + "\0");
    fingerprintTree(fingerprint, item.path, budget);
  }
  // Past the bound, changes can't be seen, so the fingerprint never matches
  // a saved one and trust is asked for again.
  if (budget.entries < 0) fingerprint.update(String(Date.now()) + Math.random());
  return {
    paths,
    fingerprint: fingerprint.digest("hex"),
    required: paths.length > 0,
  };
}

export function piSavedTrust(
  agentDir: string,
  project: string,
): { trusted: boolean; decision: string } | undefined {
  const path = join(agentDir, "trust.json");
  if (existsSync(path)) {
    const entries = JSON.parse(readFileSync(path, "utf8"));
    if (!entries || typeof entries !== "object" || Array.isArray(entries))
      throw new Error("Invalid Pi trust store");
    for (let current = project; ; current = dirname(current)) {
      if (entries[current] === true || entries[current] === false)
        return {
          trusted: entries[current],
          decision: entries[current] ? "trusted in Pi" : "declined in Pi",
        };
      if (dirname(current) === current) break;
    }
  }
  const setting = readPiSettings(
    join(agentDir, "settings.json"),
  ).defaultProjectTrust;
  if (setting === "always")
    return { trusted: true, decision: "trusted by Pi default" };
  if (setting === "never")
    return { trusted: false, decision: "declined by Pi default" };
}

export function piInstructionSources(
  agentDir: string,
  project: string,
  trusted: boolean,
) {
  const sources: Array<{
    path: string;
    role: string;
    scope: PiScope | "context";
    effective: boolean;
  }> = [];
  for (const file of ["SYSTEM.md", "APPEND_SYSTEM.md"]) {
    const personal = join(agentDir, file);
    const local = join(project, ".pi", file);
    const winner = trusted && existsSync(local) ? local : personal;
    for (const [path, scope] of [
      [personal, "user"],
      [local, "project"],
    ] as const)
      if (existsSync(path))
        sources.push({
          path,
          role:
            file === "SYSTEM.md"
              ? "Replace system prompt"
              : "Append system prompt",
          scope,
          effective: path === winner,
        });
  }
  const ancestors: string[] = [];
  for (let dir = project; ; dir = dirname(dir)) {
    ancestors.unshift(dir);
    if (dirname(dir) === dir) break;
  }
  const candidates = [agentDir, ...ancestors];
  for (const dir of candidates) {
    const choice = [
      "AGENTS.override.md",
      "AGENTS.md",
      "AGENTS.MD",
      "CLAUDE.md",
      "CLAUDE.MD",
    ].find((file) => existsSync(join(dir, file)));
    if (choice) {
      const path = join(dir, choice);
      sources.push({
        path,
        role: "Context",
        scope: "context",
        effective: true,
      });
    }
  }
  return sources;
}

export function updatePiPackageFilters(
  path: string,
  source: string,
  filters: PiPackageEntry["filters"],
  expectedHash: string,
) {
  const raw = existsSync(path) ? readFileSync(path, "utf8") : "{}";
  if (createHash("sha256").update(raw).digest("hex") !== expectedHash)
    throw new Error("Pi settings changed. Refresh and retry.");
  const settings = JSON.parse(raw);
  if (!Array.isArray(settings.packages))
    throw new Error("Package is no longer configured.");
  const index = settings.packages.findIndex(
    (item: any) => (typeof item === "string" ? item : item?.source) === source,
  );
  if (index < 0) throw new Error("Package is no longer configured.");
  const old = settings.packages[index];
  const next: Record<string, unknown> =
    typeof old === "string" ? { source: old } : { ...old };
  for (const kind of resourceKinds) {
    if (filters[kind] === undefined) delete next[kind];
    else next[kind] = filters[kind];
  }
  settings.packages[index] = next;
  const temp = path + `.loop-${process.pid}-${Date.now()}`;
  writeFileSync(temp, JSON.stringify(settings, null, 2) + "\n", {
    mode: 0o600,
  });
  renameSync(temp, path);
}

export function settingsHash(path: string) {
  return createHash("sha256")
    .update(existsSync(path) ? readFileSync(path) : "{}")
    .digest("hex");
}
