import { expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

// D1: discriminating fields are closed sets. A property with one of these
// names whose schema is an unconstrained string is a failure, unless it is on
// the exemption list below with a reason reviewers can verify (D5).
const NAMES = [
  "state",
  "status",
  "kind",
  "role",
  "origin",
  "stage",
  "outcome",
  "mode",
  "phase",
];

// An open string schema: z.string() with optional chained refiners/shorteners,
// or the Text/text/nullableText/MaybeText aliases with optional/nullable
// presence and refined (Text.min(1), Text.max(300)) modifiers. Declarations
// are matched inline (z.strictObject({ state: z.string() })) and across lines
// (state:\n  z.string()), with whitespace allowed around dots and parens.
// enum/literal/union/uuid/template-typed fields do not match, so they are not
// flagged.
const DOT = String.raw`\s*\.\s*`;
const ARGS = String.raw`\([^)]*\)`;
const OPEN = String.raw`z${DOT}string${ARGS}(?:${DOT}(?:trim|min|max|optional|nullable|nullish|catch|default)${ARGS})*|Text(?:${DOT}(?:min|max|trim|optional|nullable|nullish)${ARGS})*|text(?:${DOT}(?:min|max|trim|optional|nullable)${ARGS})*|nullableText(?:${DOT}(?:optional|nullable)${ARGS})?|MaybeText(?:${DOT}(?:optional|nullable)${ARGS})?`;
const LINE = new RegExp(
  String.raw`(?:[A-Za-z_][A-Za-z0-9_]*${DOT})?(?:["']?([A-Za-z_][A-Za-z0-9_-]*)["']?)?\s*:\s*(${OPEN})\s*(?:[,;\}\]])`,
  "g",
);

type Exemption = { count: number; reason: string };

// Exemptions: file:field, expected occurrence count, reason. The list only
// shrinks, and each exemption covers a fixed number of declarations, so a new
// `phase: Text` elsewhere in the same file cannot inherit it (D5).
const EXPLICIT_EXEMPTIONS: Array<[string, Exemption]> = [
  [
    "agent-activities.ts:origin",
    {
      count: 1,
      reason:
        "harness producer origin string (broker/loop_plan/codex/adapter ids)",
    },
  ],
  [
    "agent-contract-schemas.ts:kind",
    {
      count: 2,
      reason: "harness-defined command kinds and diagnostics entry kinds",
    },
  ],
  [
    "agent-contract-schemas.ts:origin",
    { count: 1, reason: "harness command source origin text" },
  ],
  [
    "conversation-routes.ts:state",
    {
      count: 1,
      reason:
        "native answer outcome state from the harness/authority (answered, declined, error...)",
    },
  ],
  [
    "companion-contract-schemas.ts:state",
    {
      count: 1,
      reason:
        "companion-reported native history entry state (no in-repo producer)",
    },
  ],
  [
    "execution-authority.ts:state",
    {
      count: 1,
      reason:
        "native answer reply state spans stored transitions and harness-confirmed live stages",
    },
  ],
  [
    "execution-authority.ts:origin",
    { count: 1, reason: "execution request origin text" },
  ],
  [
    "library-contract-schemas.ts:kind",
    {
      count: 1,
      reason:
        "search document discriminator spanning message and artifact kinds",
    },
  ],
  [
    "mcp-contract-schemas.ts:kind",
    {
      count: 1,
      reason:
        "agent source transport kind from wire discovery; local entries have none",
    },
  ],
  [
    "native-commands.ts:kind",
    { count: 1, reason: "harness-defined command kinds" },
  ],
  [
    "native-commands.ts:origin",
    { count: 1, reason: "command source origin text" },
  ],
  [
    "session-controls.ts:state",
    {
      count: 1,
      reason: "companion-reported session-controls state (no in-repo producer)",
    },
  ],
  [
    "social-contract-schemas.ts:kind",
    { count: 1, reason: "social feed source kind from the catalog" },
  ],
  [
    "workspace-events.ts:phase",
    { count: 1, reason: "run failure phase free text" },
  ],
];

const EXEMPTIONS = new Map<string, Exemption>([
  ...EXPLICIT_EXEMPTIONS,
  // Fleet files are removed with the fleet feature; until then every field in
  // them is exempt (count is enforced, disappearance is not).
  ...readdirSync("src/shared")
    .filter((file) => file.startsWith("fleet-"))
    .flatMap((file) =>
      NAMES.map(
        (name) =>
          [
            `${file}:${name}`,
            { count: 1, reason: "fleet removal pending" },
          ] as const,
      ),
    ),
]);

it("keeps discriminating fields in src/shared as closed sets", () => {
  const seen = new Map<string, string[]>();
  for (const file of readdirSync("src/shared").filter((f) =>
    f.endsWith(".ts"),
  )) {
    const text = readFileSync("src/shared/" + file, "utf8");
    // The quoted property name (e.g. "connection.status"), or the bare name.
    // Only properties whose name is one of the discriminating fields count.
    // The whole file is scanned so multiline declarations cannot bypass it.
    for (const match of text.matchAll(LINE)) {
      const field = match[1];
      if (!field || !NAMES.includes(field)) continue;
      const key = `${file}:${field}`;
      const list = seen.get(key) ?? [];
      list.push(`${key} :: ${match[0].replace(/\s+/g, " ").trim()}`);
      seen.set(key, list);
    }
  }
  const failures: string[] = [];
  for (const [key, lines] of seen) {
    const allowed = EXEMPTIONS.get(key)?.count ?? 0;
    if (lines.length === allowed) continue;
    failures.push(
      `${key} (${lines.length} match${lines.length === 1 ? "" : "es"}, ` +
        `${allowed} allowed):\n` +
        lines.map((l) => `  ${l}`).join("\n"),
    );
  }
  // An explicit exemption whose declaration disappeared is a sign to review
  // it (D5); the fleet wildcard only enforces counts.
  for (const [key] of EXPLICIT_EXEMPTIONS) {
    if (!seen.has(key)) failures.push(`${key} (exempted but not found)`);
  }
  expect(
    failures,
    "open discriminating fields need a closed schema or an exemption:\n" +
      failures.join("\n"),
  ).toEqual([]);
});
