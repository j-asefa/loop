import { expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseSync } from "rolldown/utils";

// Source boundaries described in docs/architecture.md.
const forbidden: Record<string, string[]> = {
  client: ["server"],
  server: ["client"],
  shared: ["client", "server"],
};

const root = resolve(import.meta.dirname, "..");
const source = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return source(path);
    return /\.(?:[cm]?[jt]sx?)$/.test(entry.name) ? [path] : [];
  });

// Module specifiers from the syntax tree, so comments, strings and regular
// expressions never count. Covers static, type-only, side-effect, re-export,
// dynamic, require, `import x = require()` and `import("...")` type forms.
function specifiers(file: string, text: string) {
  const { program, errors } = parseSync(file, text);
  if (errors.length) throw new Error(`${file}: ${errors[0].message}`);
  const found: string[] = [];
  const literal = (node: any) =>
    node?.type === "Literal" && typeof node.value === "string"
      ? node.value
      : undefined;
  const visit = (node: any): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    const specifier =
      node.type === "ImportDeclaration" ||
      node.type === "ExportAllDeclaration" ||
      node.type === "ExportNamedDeclaration" ||
      node.type === "ImportExpression" ||
      node.type === "TSImportType"
        ? literal(node.source)
        : node.type === "TSExternalModuleReference"
          ? literal(node.expression)
          : node.type === "CallExpression" &&
              node.callee?.type === "Identifier" &&
              node.callee.name === "require"
            ? literal(node.arguments[0])
            : undefined;
    if (specifier !== undefined) found.push(specifier);
    for (const value of Object.values(node)) visit(value);
  };
  visit(program);
  return found;
}

const area = (path: string) => relative(join(root, "src"), path).split(sep)[0];

it("reads every import form and ignores imports in comments and strings", () => {
  const text = [
    `import type { A } from "./a"; // import "./comment"`,
    `const s = "import './string'", r = /import ".\\/regex"/;`,
    `const b = require("./b"); const c = () => import(/* x */ "./c");`,
    `export * from "./d"; export { e } from "./e"; import "./f";`,
    `import g = require("./g"); type H = import("./h").H;`,
  ].join("\n");
  expect(specifiers("probe.ts", text).sort()).toEqual(
    ["./a", "./b", "./c", "./d", "./e", "./f", "./g", "./h"].sort(),
  );
});

// Parsing the full source tree can exceed Vitest’s 5s default on shared hosts.
it("keeps client, server and shared code from importing across their boundary", () => {
  const violations: string[] = [];
  let checked = 0;
  for (const file of source(join(root, "src"))) {
    const from = area(file);
    for (const specifier of specifiers(file, readFileSync(file, "utf8"))) {
      if (!specifier.startsWith(".")) continue;
      const to = area(resolve(dirname(file), specifier));
      if (from !== to) checked++;
      if (forbidden[from]?.includes(to))
        violations.push(`${relative(root, file)} imports ${specifier}`);
    }
  }
  expect(checked).toBeGreaterThan(100);
  expect(violations).toEqual([]);
}, 30_000);

// The feed reaches fleet code only through neutral seams such as
// src/server/effect-authority.ts and src/client/sourceAvailability.ts.
const feed = [
  "src/server/mobile-return/",
  "src/server/mobile-return.ts",
  "src/server/mobile-routes.ts",
  "src/server/results.ts",
  "src/client/Feed.tsx",
  "src/client/app/",
];
const fleetModule = (path: string) =>
  /fleet[-A-Za-z]*\.(ts|tsx|js)$/.test(path) ||
  path.startsWith("src/client/Fleet");
// Shrinking allowance: these views still render fleet UI directly. Fleet UI is
// gated by the --fleet start option (open-source scope PR 3); remove an entry
// once its file reaches fleet UI through a neutral hook.
const feedFleetAllowance = new Set([
  "src/client/app/AppPages.tsx",
  "src/client/app/AppView.tsx",
]);

function resolveModule(file: string, specifier: string) {
  const base = resolve(dirname(file), specifier);
  const candidates = [
    base,
    ...[".ts", ".tsx", ".js"].map((extension) => base + extension),
    ...(base.endsWith(".js")
      ? [".ts", ".tsx"].map((extension) => base.slice(0, -3) + extension)
      : []),
  ];
  const found = candidates.find(
    (path) => existsSync(path) && statSync(path).isFile(),
  );
  return relative(root, found ?? base)
    .split(sep)
    .join("/");
}

function feedFleetImports(file: string, text: string) {
  const path = relative(root, file).split(sep).join("/");
  if (!feed.some((prefix) => path === prefix || path.startsWith(prefix)))
    return [];
  return specifiers(file, text)
    .filter((specifier) => specifier.startsWith("."))
    .map((specifier) => resolveModule(file, specifier))
    .filter(fleetModule)
    .map((target) => `${path} imports ${target}`);
}

it("refuses a feed file that imports a fleet module", () => {
  const probe = join(root, "src/server/mobile-return/probe.ts");
  expect(
    feedFleetImports(
      probe,
      `import { recordFleetEffect } from "../fleet-effect-authorizations.js";`,
    ),
  ).toEqual([
    "src/server/mobile-return/probe.ts imports src/server/fleet-effect-authorizations.ts",
  ]);
  expect(
    feedFleetImports(
      join(root, "src/client/app/Probe.tsx"),
      `import { FleetSettings } from "../FleetSettings";\nimport { fleetComposerReason } from "../fleetCapabilities";`,
    ),
  ).toEqual([
    "src/client/app/Probe.tsx imports src/client/FleetSettings.tsx",
    "src/client/app/Probe.tsx imports src/client/fleetCapabilities.ts",
  ]);
  expect(
    feedFleetImports(
      probe,
      `import { recordEffect } from "../effect-authority.js";`,
    ),
  ).toEqual([]);
  // Outside the feed, fleet imports are not this rule's concern.
  expect(
    feedFleetImports(
      join(root, "src/server/queue.ts"),
      `import { assertFleetEffect } from "./fleet-effect-authorizations.js";`,
    ),
  ).toEqual([]);
});

it("keeps feed code from importing fleet modules", () => {
  const violations: string[] = [];
  const allowed = new Set<string>();
  for (const file of source(join(root, "src")))
    for (const violation of feedFleetImports(
      file,
      readFileSync(file, "utf8"),
    )) {
      const path = violation.split(" imports ")[0];
      if (feedFleetAllowance.has(path)) allowed.add(path);
      else violations.push(violation);
    }
  expect(violations).toEqual([]);
  // The allowance only shrinks: every entry must still need it.
  expect([...allowed].sort()).toEqual([...feedFleetAllowance].sort());
}, 30_000);

// Fleet implementation and the two process composition roots may install the
// extension. Every core caller must use the database-free effect seam.
function coreEffectImports(file: string, text: string) {
  const path = relative(root, file).split(sep).join("/");
  if (
    path.startsWith("src/server/fleet-") ||
    ["src/workspace-host.ts", "src/server/execution-worker.ts"].includes(path)
  )
    return [];
  return specifiers(file, text).flatMap((specifier) => {
    if (!specifier.startsWith(".")) return [];
    const resolved = resolveModule(file, specifier);
    return resolved === "src/server/fleet-effect-authorizations.ts"
      ? [`${path} imports ${resolved}`]
      : [];
  });
}

it("requires core effect callers to use the neutral authority seam", () => {
  const queue = join(root, "src/server/queue.ts");
  expect(
    coreEffectImports(
      queue,
      'import { assertFleetEffect } from "./fleet-effect-authorizations.js";',
    ),
  ).toEqual([
    "src/server/queue.ts imports src/server/fleet-effect-authorizations.ts",
  ]);
  expect(
    coreEffectImports(
      queue,
      'import { assertEffect } from "./effect-authority.js";',
    ),
  ).toEqual([]);
  expect(
    source(join(root, "src")).flatMap((file) =>
      coreEffectImports(file, readFileSync(file, "utf8")),
    ),
  ).toEqual([]);
}, 30_000);
