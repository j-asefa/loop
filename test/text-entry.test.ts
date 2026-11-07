import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const root = join(import.meta.dirname, "../src/client");
const nonText =
  /type=\{?"(checkbox|radio|file|hidden|range|color|date|datetime-local|time|number|submit|button)"|type=\{q\.multiple/;

// The opening tag ends at the first ">" outside JSX expressions and arrows.
function openingTag(source: string, start: number) {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0 && source[i - 1] !== "=")
      return source.slice(start, i + 1);
  }
  throw new Error("Unterminated tag");
}

it("declares the keyboard behaviour of every client text field", () => {
  const undeclared: string[] = [];
  let fields = 0;
  for (const file of readdirSync(root, { recursive: true }) as string[]) {
    if (!file.endsWith(".tsx")) continue;
    const source = readFileSync(join(root, file), "utf8");
    for (const match of source.matchAll(/<(textarea|input)\b/g)) {
      const tag = openingTag(source, match.index);
      if (nonText.test(tag)) continue;
      fields++;
      // Sign-in fields keep a real AutoFill token such as "email".
      // A shared preset only counts if no later prop overrides its hints.
      const preset = tag.match(/\{\.\.\.(proseEntry|literalEntry)\}/);
      if (
        (preset &&
          !/\b(autoComplete|autoCorrect|autoCapitalize|spellCheck)=/.test(
            tag.slice(preset.index),
          )) ||
        /autoComplete=(\{[^}]*"(name|email|\w+-password)"|"(name|email)")/.test(
          tag,
        )
      )
        continue;
      const line = source.slice(0, match.index).split("\n").length;
      undeclared.push(`${file}:${line}`);
    }
  }
  expect(fields).toBeGreaterThan(80);
  expect(undeclared).toEqual([]);
});

// Safari reads visible text before a field to guess contact fields, so a
// field after agent-written text needs a form-control boundary first.
it("bounds the Safari label search for fields after agent text", () => {
  const fields = [
    ["app/Composer.tsx", 'id="composer"'],
    ["NativeControls.tsx", 'className="native-question-response"'],
    ["ArtifactViewer.tsx", "onChange={(e) => setText(e.target.value)}"],
  ];
  for (const [file, marker] of fields) {
    const source = readFileSync(join(root, file), "utf8");
    const start = [...source.matchAll(/<textarea\b/g)].find((match) =>
      openingTag(source, match.index).includes(marker),
    )?.index;
    expect(start, file).toBeDefined();
    expect(source.slice(0, start).trimEnd(), file).toMatch(
      /<AutofillBoundary>$/,
    );
  }
});
