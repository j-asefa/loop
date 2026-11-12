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
// presence modifiers. enum/literal/union/uuid/template-typed fields do not
// match, so they are not flagged.
const OPEN = String.raw`(?:z\.string\(\)(?:\s*\.\s*(?:trim|min|max|optional|nullable|nullish|catch|default)\([^)]*\))*|Text(?:\s*\.\s*(?:optional|nullable|nullish)\(\))?|text(?:\s*\.\s*(?:optional|nullable)\(\))?|nullableText|MaybeText(?:\s*\.\s*(?:optional|nullable)\(\))?)`;
const LINE = new RegExp(
  `^\\s*(?:[A-Za-z_]+\\.)?(?:["']?([A-Za-z_][A-Za-z0-9_-]*)["']?)?\\s*:\\s*${OPEN}\\s*[,;]?$`,
);

// Exemptions: file, field, reason. The list only shrinks.
const EXEMPTIONS = new Map([
  [
    "agent-activities.ts:origin",
    "harness producer origin string (broker/loop_plan/codex/adapter ids)",
  ],
  ["agent-contract-schemas.ts:kind", "harness-defined command kinds"],
  ["agent-contract-schemas.ts:origin", "harness command source origin text"],
  [
    "library-contract-schemas.ts:kind",
    "search document discriminator spanning message and artifact kinds",
  ],
  [
    "execution-authority.ts:state",
    "native answer reply state spans stored transitions and harness-confirmed live stages",
  ],
  ["execution-authority.ts:origin", "execution request origin text"],
  ["native-commands.ts:kind", "harness-defined command kinds"],
  ["native-commands.ts:origin", "command source origin text"],
  [
    "session-controls.ts:state",
    "companion-reported session-controls state (no in-repo producer)",
  ],
  [
    "social-contract-schemas.ts:kind",
    "social feed source kind from the catalog",
  ],
  ["workspace-events.ts:phase", "run failure phase free text"],
  ...readdirSync("src/shared")
    .filter((file) => file.startsWith("fleet-"))
    .flatMap((file) =>
      NAMES.map(
        (name) => [`${file}:${name}`, "fleet removal pending"] as const,
      ),
    ),
]);

it("keeps discriminating fields in src/shared as closed sets", () => {
  const failures: string[] = [];
  for (const file of readdirSync("src/shared").filter((f) =>
    f.endsWith(".ts"),
  )) {
    const text = readFileSync("src/shared/" + file, "utf8");
    for (const line of text.split("\n")) {
      const match = LINE.exec(line);
      if (!match) continue;
      // The quoted property name (e.g. "connection.status"), or the bare name.
      // Only properties whose name is one of the discriminating fields count.
      const field = match[1];
      if (!field || !NAMES.includes(field)) continue;
      const key = `${file}:${field}`;
      if (EXEMPTIONS.has(key)) continue;
      failures.push(`${key} :: ${line.trim()}`);
    }
  }
  expect(
    failures,
    "open discriminating fields need a closed schema or an exemption:\n" +
      failures.join("\n"),
  ).toEqual([]);
});
